/* ==========================================================================
   KairosPA — Firebase Cloud Functions
   Scheduled background worker that sends push notifications to all user
   devices when a task's due time arrives, even if the browser is closed.
   ========================================================================== */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Runs every minute and checks for due tasks across all users.
 * For each pending, unnotified task whose dueTimestamp has passed,
 * it sends a push notification to every device the user is signed in on,
 * then marks the task as notified in Firestore.
 *
 * Firestore data structure expected:
 *   users/{uid}/tasks/{taskId}   → { title, dueTimestamp, status, notified }
 *   users/{uid}/fcm_tokens/{token} → { token }
 */
async function sendFCMNotification(uid, title, body, taskId) {
  const tokensSnapshot = await db
    .collection("users")
    .doc(uid)
    .collection("fcm_tokens")
    .get();

  if (tokensSnapshot.empty) {
    console.log(`No FCM tokens found for user ${uid}.`);
    return;
  }

  const tokens = tokensSnapshot.docs.map((d) => d.data().token).filter(Boolean);
  if (tokens.length === 0) return;

  const message = {
    notification: {
      title: title,
      body: body,
    },
    data: {
      taskId: taskId,
    },
    tokens,
  };

  const response = await messaging.sendEachForMulticast(message);
  console.log(
    `Sent to ${tokens.length} device(s) for user ${uid}. ` +
    `Success: ${response.successCount}, Failed: ${response.failureCount}`
  );

  const staleTokenDeletions = [];
  response.responses.forEach((resp, idx) => {
    if (!resp.success) {
      const errorCode = resp.error?.code;
      if (
        errorCode === "messaging/invalid-registration-token" ||
        errorCode === "messaging/registration-token-not-registered"
      ) {
        staleTokenDeletions.push(
          db.collection("users").doc(uid)
            .collection("fcm_tokens").doc(tokens[idx]).delete()
        );
      }
    }
  });
  if (staleTokenDeletions.length > 0) {
    await Promise.all(staleTokenDeletions);
  }
}

exports.checkScheduledTasks = functions.pubsub
  .schedule("every 1 minutes")
  .onRun(async (context) => {
    const now = Date.now();

    try {
      // 1. Standard due tasks query (where status is active: pending, not-started, in-progress)
      const overduePromise = db
        .collectionGroup("tasks")
        .where("status", "in", ["pending", "not-started", "in-progress"])
        .where("notified", "==", false)
        .where("dueTimestamp", "<=", now)
        .get();

      // 2. Leading tasks query
      const leadingPromise = db
        .collectionGroup("tasks")
        .where("status", "in", ["pending", "not-started", "in-progress"])
        .where("reminderSchedule", "in", ["daily-lead", "weekly-lead"])
        .get();

      const [overdueSnapshot, leadingSnapshot] = await Promise.all([overduePromise, leadingPromise]);

      const standardPromises = overdueSnapshot.empty ? [] : overdueSnapshot.docs.map(async (taskDoc) => {
        const task = taskDoc.data();
        const pathParts = taskDoc.ref.path.split("/");
        const uid = pathParts[1];

        try {
          await sendFCMNotification(
            uid,
            "⏰ KairosPA Reminder",
            task.title || "You have a task due!",
            taskDoc.id
          );
          await taskDoc.ref.update({ notified: true });
        } catch (innerErr) {
          console.error(`Error processing standard task ${taskDoc.id} for user ${uid}:`, innerErr);
        }
      });

      const leadingPromises = leadingSnapshot.empty ? [] : leadingSnapshot.docs.map(async (taskDoc) => {
        const task = taskDoc.data();
        if (task.dueTimestamp <= now) {
          return;
        }

        const pathParts = taskDoc.ref.path.split("/");
        const uid = pathParts[1];

        try {
          const eventUtcTimestamp = Date.parse(`${task.date}T${task.time}:00Z`);
          if (isNaN(eventUtcTimestamp)) return;

          const userOffsetMs = task.dueTimestamp - eventUtcTimestamp;
          const userLocalNow = new Date(now + userOffsetMs);
          const userTodayStr = userLocalNow.toISOString().split("T")[0];
          const userCurrentTimeStr = `${String(userLocalNow.getUTCHours()).padStart(2, "0")}:${String(
            userLocalNow.getUTCMinutes()
          ).padStart(2, "0")}`;

          if (task.date <= userTodayStr) {
            return;
          }

          if (userCurrentTimeStr < task.time) {
            return;
          }

          if (task.lastLeadingReminderFiredDate === userTodayStr) {
            return;
          }

          const eventDate = new Date(task.date + "T00:00:00Z");
          const todayDate = new Date(userTodayStr + "T00:00:00Z");
          const diffTime = eventDate.getTime() - todayDate.getTime();
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays <= 0) return;

          let shouldTrigger = false;
          if (task.reminderSchedule === "daily-lead") {
            shouldTrigger = true;
          } else if (task.reminderSchedule === "weekly-lead") {
            if (!task.lastLeadingReminderFiredDate) {
              if (diffDays % 7 === 0) {
                shouldTrigger = true;
              }
            } else {
              const lastFireDate = new Date(task.lastLeadingReminderFiredDate + "T00:00:00Z");
              const daysSinceLastFire = Math.ceil((todayDate.getTime() - lastFireDate.getTime()) / (1000 * 60 * 60 * 24));
              if (daysSinceLastFire >= 7) {
                shouldTrigger = true;
              }
            }
          }

          if (shouldTrigger) {
            const leadType = task.reminderSchedule === "daily-lead" ? "Daily" : "Weekly";
            await sendFCMNotification(
              uid,
              `⏰ ${leadType} Reminder: ${task.title}`,
              `Upcoming event on ${task.date} at ${task.time}`,
              taskDoc.id
            );
            await taskDoc.ref.update({ lastLeadingReminderFiredDate: userTodayStr });
          }
        } catch (innerErr) {
          console.error(`Error processing leading task ${taskDoc.id} for user ${uid}:`, innerErr);
        }
      });

      await Promise.all([...standardPromises, ...leadingPromises]);
      console.log("checkScheduledTasks complete.");
      return null;
    } catch (err) {
      console.error("checkScheduledTasks error:", err);
      return null;
    }
  });
