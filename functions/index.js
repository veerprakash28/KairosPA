/* ==========================================================================
   ChronosPA — Firebase Cloud Functions
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
exports.checkScheduledTasks = functions.pubsub
  .schedule("every 1 minutes")
  .onRun(async (context) => {
    const now = Date.now();

    try {
      // Query all pending, unnotified tasks across all users that are due
      // This uses a collection group query — requires a Firestore composite index
      const overdueSnapshot = await db
        .collectionGroup("tasks")
        .where("status", "==", "pending")
        .where("notified", "==", false)
        .where("dueTimestamp", "<=", now)
        .get();

      if (overdueSnapshot.empty) {
        console.log("No due tasks at this time.");
        return null;
      }

      console.log(`Found ${overdueSnapshot.size} due task(s). Sending notifications...`);

      const promises = overdueSnapshot.docs.map(async (taskDoc) => {
        const task = taskDoc.data();

        // Extract the user ID from the document path: users/{uid}/tasks/{taskId}
        const pathParts = taskDoc.ref.path.split("/");
        const uid = pathParts[1];

        try {
          // Get all registered FCM tokens for this user
          const tokensSnapshot = await db
            .collection("users")
            .doc(uid)
            .collection("fcm_tokens")
            .get();

          if (tokensSnapshot.empty) {
            console.log(`No FCM tokens found for user ${uid}.`);
          } else {
            const tokens = tokensSnapshot.docs.map((d) => d.data().token).filter(Boolean);

            // Send push notification to all the user's devices
            const message = {
              notification: {
                title: "⏰ ChronosPA Reminder",
                body: task.title || "You have a task due!",
              },
              data: {
                taskId: taskDoc.id,
              },
              tokens,
            };

            const response = await messaging.sendEachForMulticast(message);
            console.log(
              `Sent to ${tokens.length} device(s) for user ${uid}. ` +
              `Success: ${response.successCount}, Failed: ${response.failureCount}`
            );

            // Clean up stale tokens that are no longer registered
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
            await Promise.all(staleTokenDeletions);
          }

          // Mark task as notified so we don't send it again
          await taskDoc.ref.update({ notified: true });

        } catch (innerErr) {
          console.error(`Error processing task ${taskDoc.id} for user ${uid}:`, innerErr);
        }
      });

      await Promise.all(promises);
      console.log("checkScheduledTasks complete.");
      return null;
    } catch (err) {
      console.error("checkScheduledTasks error:", err);
      return null;
    }
  });
