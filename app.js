/* ==========================================================================
   KairosPA Javascript - Application Logic, Firebase Sync, Notifications
   ========================================================================== */

// --- Firebase Configuration Variables ---
let firebaseConfig = null;
let db = null;
let auth = null;
let fcmMessaging = null;  // Firebase Cloud Messaging for push notifications
let userTasksUnsubscribe = null;
let userChatUnsubscribe = null;
let currentUser = null;
let firebaseActive = false;

// Load Firebase config from config.json (injected by GitHub Actions on deploy)
async function loadFirebaseConfig() {
  try {
    const response = await fetch("config.json");
    if (response.ok) {
      const data = await response.json();
      if (data && data.apiKey) {
        firebaseConfig = data;
        return true;
      }
    }
  } catch (e) {
    // Normal if config.json does not exist (local dev without Firebase)
  }
  return false;
}

function initFirebase() {
  if (!firebaseConfig || !firebaseConfig.apiKey) {
    return false;
  }
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    // Initialize FCM only if supported by the browser
    if (firebase.messaging && firebase.messaging.isSupported && firebase.messaging.isSupported()) {
      try {
        fcmMessaging = firebase.messaging();
      } catch (e) {
        console.warn("FCM init skipped:", e.message);
      }
    }
    return true;
  } catch (err) {
    console.error("Firebase init failed:", err);
    return false;
  }
}

// --- Global App State ---
let AppState = {
  tasks: [],
  preferences: {
    username: "User",
    soundEnabled: true,
    notificationPermission: null,
    notificationsMuted: false
  },
  currentCalendarMonth: new Date().getMonth(),
  currentCalendarYear: new Date().getFullYear(),
  selectedCalendarDate: new Date(),
  activeAlertTask: null,
  modalSource: "manual"
};

// --- Constant Priority Mappings ---
const PriorityLabel = {
  low: "Low Priority",
  medium: "Medium Priority",
  high: "HIGH PRIORITY"
};

const statusLabels = {
  "not-started": "Not Started",
  "in-progress": "In Progress",
  "completed": "Completed",
  "pushed": "Pushed to Tomorrow"
};

const priorityLabels = {
  "low": "Low",
  "medium": "Medium",
  "high": "High"
};

// --- On Initial Load ---
document.addEventListener("DOMContentLoaded", async () => {
  // Always load the local state (tasks, preferences, chat logs) on startup first
  loadState();

  if (AppState.preferences && AppState.preferences.sidebarCollapsed) {
    document.body.classList.add("sidebar-collapsed");
  }

  initClock();
  initCalendar();
  initEventListeners();
  requestNotificationPermission(true); // check status silently
  renderChatHistory();

  const configLoaded = await loadFirebaseConfig();
  firebaseActive = configLoaded && initFirebase();

  // Always initialize auth form toggles and SSO bindings so the UI handles clicks normally
  initFirebaseAuth();

  if (!firebaseActive) {
    // No Firebase config — silently skip sign-in overlay and go straight to the app
    document.getElementById("auth-overlay").classList.add("hidden");
    checkOverduePreviousDays();
    refreshAllViews();
  } else {
    // Firebase is active — register service worker
    registerServiceWorker();
  }
});

// --- LocalStorage Persistence (fallback when no Firebase) ---
function saveState() {
  if (!firebaseActive || !currentUser) {
    localStorage.setItem("KairosPA_State", JSON.stringify(AppState));
  }
}

function loadState() {
  const saved = localStorage.getItem("KairosPA_State") || localStorage.getItem("ChronosPA_State");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      AppState.tasks = (parsed.tasks || []).filter(t => !t.id.startsWith("demo-")).map(t => {
        // Convert old status values to the new Notion-like schema
        if (t.status === "pending") t.status = "not-started";
        if (!t.status) t.status = "not-started";
        if (!t.source) t.source = "manual";
        if (!t.reminderSchedule) t.reminderSchedule = "once";
        return t;
      });
      AppState.preferences = parsed.preferences || AppState.preferences;
      AppState.chatHistory = parsed.chatHistory || [];
    } catch (e) {
      console.error("Error loading localStorage state:", e);
    }
  } else {
    AppState.tasks = [];
    AppState.chatHistory = [];
    saveState();
  }
}

// --- Firebase Auth Handlers ---
function initFirebaseAuth() {
  // Auth Form Switches
  document.getElementById("switch-to-signup").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("auth-login-form").classList.add("hidden");
    document.getElementById("auth-signup-form").classList.remove("hidden");
  });

  document.getElementById("switch-to-login").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("auth-signup-form").classList.add("hidden");
    document.getElementById("auth-login-form").classList.remove("hidden");
  });

  // Sign Out handler — deletes FCM token first, then signs out
  document.getElementById("auth-signout-btn").addEventListener("click", async () => {
    document.getElementById("profile-dropdown").classList.add("hidden");
    try {
      // Remove this device's FCM token from Firestore before signing out
      if (fcmMessaging && currentUser && db) {
        try {
          const token = await fcmMessaging.getToken();
          if (token) {
            await db.collection("users").doc(currentUser.uid)
              .collection("fcm_tokens").doc(token).delete();
          }
        } catch (e) {
          console.warn("FCM token removal skipped:", e.message);
        }
      }
      await auth.signOut();
      addAssistantMessage("👋 You have signed out. See you next time!");
    } catch (err) {
      console.error("Sign out error:", err);
    }
  });

  // Google Sign-In handler (works for both Sign In and Sign Up)
  const handleGoogleSignIn = () => {
    if (!firebaseActive) {
      const errorEl = document.getElementById("login-error");
      errorEl.textContent = "Google Sign-In is temporarily unavailable. Please try again later.";
      errorEl.classList.remove("hidden");
      return;
    }
    const provider = new firebase.auth.GoogleAuthProvider();
    auth.signInWithPopup(provider)
      .then((result) => {
        const user = result.user;
        const displayName = user.displayName || user.email.split("@")[0];
        addAssistantMessage(`🎉 Welcome, **${displayName}**! Signed in with Google.`);
      })
      .catch((err) => {
        if (err.code !== "auth/popup-closed-by-user" && err.code !== "auth/cancelled-popup-request") {
          const errorEl = document.getElementById("login-error");
          errorEl.textContent = friendlyAuthError(err.code);
          errorEl.classList.remove("hidden");
        }
      });
  };

  document.getElementById("google-signin-btn").addEventListener("click", handleGoogleSignIn);
  document.getElementById("google-signup-btn").addEventListener("click", handleGoogleSignIn);

  // Login Submit handler
  document.getElementById("auth-login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("login-error");
    errorEl.classList.add("hidden");

    if (!firebaseActive) {
      errorEl.textContent = "Sign in is temporarily unavailable. Please try again later.";
      errorEl.classList.remove("hidden");
      return;
    }

    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    auth.signInWithEmailAndPassword(email, password)
      .then(() => {
        document.getElementById("login-email").value = "";
        document.getElementById("login-password").value = "";
      })
      .catch(err => {
        errorEl.textContent = friendlyAuthError(err.code);
        errorEl.classList.remove("hidden");
      });
  });

  // Signup Submit handler
  document.getElementById("auth-signup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("signup-error");
    errorEl.classList.add("hidden");

    if (!firebaseActive) {
      errorEl.textContent = "Creating an account is temporarily unavailable. Please try again later.";
      errorEl.classList.remove("hidden");
      return;
    }

    const name = document.getElementById("signup-name").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;

    auth.createUserWithEmailAndPassword(email, password)
      .then((userCredential) => {
        const user = userCredential.user;
        return user.updateProfile({ displayName: name });
      })
      .then(() => {
        // Save user profile details to Firestore
        saveUserProfile(auth.currentUser);

        document.getElementById("signup-name").value = "";
        document.getElementById("signup-email").value = "";
        document.getElementById("signup-password").value = "";
        addAssistantMessage(`👋 Welcome to KairosPA, **${name}**! Your account is ready.`);
      })
      .catch(err => {
        errorEl.textContent = friendlyAuthError(err.code);
        errorEl.classList.remove("hidden");
      });
  });

  // Auth state change handler — the core of the user experience
  if (firebaseActive && auth) {
    auth.onAuthStateChanged(user => {
      const authOverlay = document.getElementById("auth-overlay");
      const nameLabel = document.getElementById("profile-name-label");
      const dropName = document.getElementById("dropdown-user-name");
      const dropEmail = document.getElementById("dropdown-user-email");
      const signInBtn = document.getElementById("auth-open-btn");
      const signOutBtn = document.getElementById("auth-signout-btn");

      if (user) {
        currentUser = user;

        // Update UI
        const displayName = user.displayName || user.email.split("@")[0];
        nameLabel.textContent = displayName;
        dropName.textContent = displayName;
        dropEmail.textContent = user.email;
        AppState.preferences.username = displayName;

        // Show sign out, hide sign in
        if (signInBtn) signInBtn.classList.add("hidden");
        if (signOutBtn) signOutBtn.classList.remove("hidden");

        // Hide login overlay
        authOverlay.classList.add("hidden");

        // Save user profile details to Firestore
        saveUserProfile(user);

        // Start Firestore real-time sync
        syncTasksFromFirestore(user.uid);
        syncChatFromFirestore(user.uid);

        // Register FCM push token for this device
        initFcmMessaging(user.uid);

        addAssistantMessage(`🔒 Synced! Welcome back, **${displayName}**.`);
      } else {
        currentUser = null;

        // Reset UI
        nameLabel.textContent = "Sign In";
        dropName.textContent = "Guest User";
        dropEmail.textContent = "Please sign in to sync";

        // Reset user state to local guest mode
        AppState.preferences.username = "User";
        loadState(); // Restore local guest tasks and chat logs

        // Show sign in, hide sign out
        if (signInBtn) signInBtn.classList.remove("hidden");
        if (signOutBtn) signOutBtn.classList.add("hidden");

        // Unsubscribe from Firestore
        if (userTasksUnsubscribe) {
          userTasksUnsubscribe();
          userTasksUnsubscribe = null;
        }
        if (userChatUnsubscribe) {
          userChatUnsubscribe();
          userChatUnsubscribe = null;
        }

        // Render local state
        refreshAllViews();
      }
    });
  }
}

// Convert Firebase error codes to user-friendly messages
function friendlyAuthError(code) {
  const messages = {
    "auth/user-not-found": "No account found with this email. Try creating one!",
    "auth/wrong-password": "Incorrect password. Please try again.",
    "auth/invalid-credential": "Invalid email or password. Please check and try again.",
    "auth/email-already-in-use": "This email is already registered. Try signing in instead.",
    "auth/weak-password": "Password is too weak. Use at least 6 characters.",
    "auth/invalid-email": "Please enter a valid email address.",
    "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
    "auth/network-request-failed": "Network error. Check your internet connection.",
    "auth/popup-blocked": "Popup was blocked. Please allow popups for this site and try again.",
    "auth/account-exists-with-different-credential": "An account already exists with this email. Try signing in with your original method."
  };
  return messages[code] || "Something went wrong. Please try again.";
}

// --- Save User Profile to Firestore ---
function saveUserProfile(user) {
  if (!firebaseActive || !db || !user) return;

  const userDocRef = db.collection("users").doc(user.uid);
  const profileData = {
    uid: user.uid,
    displayName: user.displayName || user.email.split("@")[0] || "User",
    email: user.email || "",
    photoURL: user.photoURL || "",
    lastActive: firebase.firestore.FieldValue.serverTimestamp()
  };

  userDocRef.set(profileData, { merge: true })
    .then(() => {
      console.log("User profile successfully saved to Firestore:", profileData);
    })
    .catch(err => {
      console.error("Error saving user profile to Firestore:", err);
    });
}

// --- Firestore Real-Time Sync ---
function syncTasksFromFirestore(uid) {
  if (userTasksUnsubscribe) {
    userTasksUnsubscribe();
  }

  userTasksUnsubscribe = db.collection("users").doc(uid).collection("tasks")
    .onSnapshot(snapshot => {
      let tasksList = [];
      snapshot.forEach(doc => {
        tasksList.push(doc.data());
      });
      AppState.tasks = tasksList;

      // Re-render everything reactively
      renderTimeline();
      renderCalendar();
      renderSelectedDayPreview();
      updateMetrics();
      checkOverduePreviousDays();
    }, err => {
      console.error("Firestore sync error:", err);
    });
}

// --- Firestore Real-Time Chat logs Sync ---
function syncChatFromFirestore(uid) {
  if (userChatUnsubscribe) {
    userChatUnsubscribe();
  }

  userChatUnsubscribe = db.collection("users").doc(uid).collection("chatHistory")
    .orderBy("timestamp", "asc")
    .onSnapshot(snapshot => {
      let history = [];
      snapshot.forEach(doc => {
        history.push(doc.data());
      });
      AppState.chatHistory = history;
      renderChatHistory();
    }, err => {
      console.error("Firestore chat sync error:", err);
    });
}

function drawMessageInLog(msg) {
  const log = document.getElementById("pa-chat-log");
  if (!log) return;
  const msgEl = document.createElement("div");
  if (msg.sender === "assistant") {
    msgEl.className = `chat-message assistant-message ${msg.className || ""}`;
    msgEl.innerHTML = `
      <div class="message-content">${formatMarkdown(msg.text)}</div>
      <div class="message-meta">${msg.time || "Just now"}</div>
    `;
  } else {
    msgEl.className = "chat-message user-message";
    msgEl.innerHTML = `
      <div class="message-content">${msg.text}</div>
      <div class="message-meta">${msg.time || "Just now"}</div>
    `;
  }
  log.appendChild(msgEl);
  log.scrollTop = log.scrollHeight;
}

// --- FCM Push Notification Token Registration ---
async function initFcmMessaging(uid) {
  if (!fcmMessaging || !db) return;
  if (AppState.preferences.notificationsMuted) {
    console.log("FCM registration skipped: notifications are muted on this device.");
    return;
  }
  if (!firebaseConfig.vapidKey) {
    console.warn("No VAPID key in config — push notifications when browser is closed will not work.");
    return;
  }

  try {
    // Ensure notification permission is granted
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return;

    // Get or refresh the FCM registration token
    const token = await fcmMessaging.getToken({ vapidKey: firebaseConfig.vapidKey });
    if (!token) return;

    // Store the token under the user's FCM tokens collection in Firestore
    await db.collection("users").doc(uid).collection("fcm_tokens").doc(token).set({
      token,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      userAgent: navigator.userAgent
    });

    // Update the notification button in the UI
    const btn = document.getElementById("notification-toggle-btn");
    const btnText = document.getElementById("notification-btn-text");
    if (btn) btn.className = "status-btn permission-granted";
    if (btnText) btnText.textContent = "Notifications Active";

    console.log("FCM token registered for push notifications.");

    // Listen for foreground push messages and show them as assistant messages
    fcmMessaging.onMessage(payload => {
      const title = payload.notification?.title || "KairosPA";
      const body = payload.notification?.body || "You have a task due!";
      addAssistantMessage(`🔔 **${title}**: ${body}`, "alert-msg");
    });
  } catch (err) {
    console.warn("FCM token registration failed:", err.message);
  }
}

// --- Task Due Timestamp Helper ---
// Computes a UTC epoch ms timestamp from local date string (YYYY-MM-DD) and time string (HH:MM)
function getTaskTimestamp(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  try {
    const [year, month, day] = dateStr.split("-").map(Number);
    const [hours, minutes] = timeStr.split(":").map(Number);
    return new Date(year, month - 1, day, hours, minutes, 0, 0).getTime();
  } catch (e) {
    return null;
  }
}

// --- Firestore helper: save a single task ---
function firestoreSaveTask(task) {
  if (db && currentUser) {
    return db.collection("users").doc(currentUser.uid).collection("tasks").doc(task.id).set(task);
  }
  return Promise.resolve();
}

function firestoreUpdateTask(taskId, updates) {
  if (db && currentUser) {
    // If date or time is being updated, recompute dueTimestamp
    const task = AppState.tasks.find(t => t.id === taskId);
    if (task && (updates.date || updates.time)) {
      const newDate = updates.date || task.date;
      const newTime = updates.time || task.time;
      updates.dueTimestamp = getTaskTimestamp(newDate, newTime);
    }
    return db.collection("users").doc(currentUser.uid).collection("tasks").doc(taskId).update(updates);
  }
  return Promise.resolve();
}

function firestoreDeleteTask(taskId) {
  if (db && currentUser) {
    return db.collection("users").doc(currentUser.uid).collection("tasks").doc(taskId).delete();
  }
  return Promise.resolve();
}

// --- Live Clock & Time Management ---
function initClock() {
  const clockTime = document.getElementById("clock-time");
  const clockDate = document.getElementById("clock-date");
  const greetingText = document.getElementById("greeting-text");

  function tick() {
    const now = new Date();

    clockTime.textContent = now.toLocaleTimeString([], { hour12: false });
    clockDate.textContent = now.toLocaleDateString([], {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
    });

    const hour = now.getHours();
    let greeting = "Good Night";
    if (hour >= 5 && hour < 12) greeting = "Good Morning";
    else if (hour >= 12 && hour < 17) greeting = "Good Afternoon";
    else if (hour >= 17 && hour < 22) greeting = "Good Evening";

    greetingText.textContent = `${greeting}, ${AppState.preferences.username}`;
    checkSchedulerAlerts(now);
  }

  tick();
  setInterval(tick, 1000);
}

// --- Premium Space Chime Web Audio Synthesizer ---
function playNotificationChime() {
  if (!AppState.preferences.soundEnabled) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const frequencies = [659.25, 880.00, 1109.73];

    frequencies.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      const startTime = ctx.currentTime + index * 0.14;
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.25, startTime + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + 1.4);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + 1.5);
    });
  } catch (err) {
    console.warn("Audio Context blocked or failed:", err);
  }
}

// --- Native Browser Notification Handler ---
function requestNotificationPermission(silent = false) {
  const btn = document.getElementById("notification-toggle-btn");
  const btnText = document.getElementById("notification-btn-text");

  if (!("Notification" in window)) {
    btnText.textContent = "Not Supported";
    return;
  }

  if (Notification.permission === "granted") {
    if (!silent) {
      AppState.preferences.notificationsMuted = !AppState.preferences.notificationsMuted;
      saveState();

      if (AppState.preferences.notificationsMuted) {
        btn.className = "status-btn permission-denied";
        btnText.textContent = "Notifications Muted";
        addAssistantMessage("🔕 Notifications muted. You will not receive task alerts on this browser.");

        // Clean FCM token from Firestore if online
        if (fcmMessaging && currentUser && db) {
          fcmMessaging.getToken()
            .then(token => {
              if (token) {
                return db.collection("users").doc(currentUser.uid)
                  .collection("fcm_tokens").doc(token).delete();
              }
            })
            .then(() => console.log("FCM token removed due to mute."))
            .catch(err => console.warn("Failed to remove FCM token on mute:", err));
        }
      } else {
        btn.className = "status-btn permission-granted";
        btnText.textContent = "Notifications Active";
        addAssistantMessage("🔔 Notifications activated. You will receive task alerts.");

        // Re-register FCM token if online
        if (currentUser) {
          initFcmMessaging(currentUser.uid);
        }
      }
    } else {
      // Load preference during boot
      if (AppState.preferences.notificationsMuted) {
        btn.className = "status-btn permission-denied";
        btnText.textContent = "Notifications Muted";
      } else {
        btn.className = "status-btn permission-granted";
        btnText.textContent = "Notifications Active";
      }
    }
    AppState.preferences.notificationPermission = "granted";
    saveState();
  } else if (Notification.permission === "denied") {
    btn.className = "status-btn permission-denied";
    btnText.textContent = "Blocked";
  } else {
    if (!silent) {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          AppState.preferences.notificationsMuted = false;
          btn.className = "status-btn permission-granted";
          btnText.textContent = "Notifications Active";
          playNotificationChime();
          addAssistantMessage("🔔 Notifications activated. You will receive task alerts.");
          if (currentUser) {
            initFcmMessaging(currentUser.uid);
          }
        } else {
          btn.className = "status-btn permission-denied";
          btnText.textContent = "Blocked";
        }
        AppState.preferences.notificationPermission = permission;
        saveState();
      });
    }
  }
}

// --- Scheduler: Compare tasks with clock and trigger alerts ---
function checkSchedulerAlerts(now) {
  const todayStr = getLocalDateString(now);
  const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  let stateUpdated = false;

  AppState.tasks.forEach(task => {
    // 1. Standard reminder check
    if (task.date === todayStr && task.status !== "completed" && task.status !== "pushed" && !task.notified) {
      if (task.time <= currentTimeStr) {
        task.notified = true;
        stateUpdated = true;
        triggerReminder(task, false);
      }
    }

    // 2. Leading reminder check for future tasks
    if (task.date > todayStr && task.status !== "completed" && task.status !== "pushed") {
      if (task.reminderSchedule === "daily-lead" || task.reminderSchedule === "weekly-lead") {
        if (task.time <= currentTimeStr) {
          const eventDate = new Date(task.date + "T00:00:00");
          const todayDate = new Date(todayStr + "T00:00:00");
          const diffTime = eventDate.getTime() - todayDate.getTime();
          const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

          if (diffDays > 0) {
            let shouldTrigger = false;

            if (task.reminderSchedule === "daily-lead") {
              if (task.lastLeadingReminderFiredDate !== todayStr) {
                shouldTrigger = true;
              }
            } else if (task.reminderSchedule === "weekly-lead") {
              if (task.lastLeadingReminderFiredDate !== todayStr) {
                if (!task.lastLeadingReminderFiredDate) {
                  if (diffDays % 7 === 0) {
                    shouldTrigger = true;
                  }
                } else {
                  const lastFire = new Date(task.lastLeadingReminderFiredDate + "T00:00:00");
                  const daysSinceLastFire = Math.ceil((todayDate.getTime() - lastFire.getTime()) / (1000 * 60 * 60 * 24));
                  if (daysSinceLastFire >= 7) {
                    shouldTrigger = true;
                  }
                }
              }
            }

            if (shouldTrigger) {
              task.lastLeadingReminderFiredDate = todayStr;
              stateUpdated = true;
              triggerReminder(task, true);

              if (db && currentUser) {
                firestoreUpdateTask(task.id, { lastLeadingReminderFiredDate: todayStr })
                  .catch(err => console.error("Update leading reminder fire date failed:", err));
              }
            }
          }
        }
      }
    }
  });

  if (stateUpdated) {
    saveState();
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
  }
}

// --- Trigger System-level & In-App Alerts ---
function triggerReminder(task, isLeading = false) {
  let title = task.title;
  let body = isLeading ? `Upcoming event on ${task.date} at ${task.time}` : `Scheduled for today at ${task.time}`;
  let textForChat = `⏰ ALERT: Time to do: "**${task.title}**". Mark completed or postpone it.`;

  if (isLeading) {
    const leadType = task.reminderSchedule === "daily-lead" ? "Daily" : "Weekly";
    title = `⏰ ${leadType} Reminder: ${task.title}`;
    textForChat = `⏰ ${leadType} Leading Reminder: Prepare for "**${task.title}**" (Event on ${task.date} at ${task.time}).`;
  }

  if (AppState.preferences.notificationsMuted) {
    addAssistantMessage(`${textForChat} (Muted)`, "alert-msg");
    showInAppAlertModal(task, isLeading);
    return;
  }

  playNotificationChime();

  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: body,
        icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="%2300f3ff"><circle cx="50" cy="50" r="40" stroke="black" stroke-width="4"/></svg>'
      });
    } catch (e) {
      console.warn("Failed to pop desktop notification:", e);
    }
  }

  addAssistantMessage(textForChat, "alert-msg");
  showInAppAlertModal(task, isLeading);
}

function showInAppAlertModal(task, isLeading = false) {
  AppState.activeAlertTask = task;

  document.getElementById("alert-task-title").textContent = task.title;
  const [h, m] = task.time.split(":");
  const ampm = h >= 12 ? "PM" : "AM";
  const displayTime = `${h % 12 || 12}:${m} ${ampm}`;

  if (isLeading) {
    const leadType = task.reminderSchedule === "daily-lead" ? "Daily" : "Weekly";
    document.getElementById("alert-task-time").textContent = `${leadType} Alert (Event: ${task.date} ${displayTime})`;
  } else {
    document.getElementById("alert-task-time").textContent = displayTime;
  }

  const priorityBadge = document.getElementById("alert-task-priority");
  priorityBadge.className = `alert-priority-badge prio-${task.priority}`;
  priorityBadge.textContent = PriorityLabel[task.priority] + (isLeading ? " (UPCOMING)" : "");

  document.getElementById("alert-overlay").classList.remove("hidden");
}

function hideInAppAlertModal() {
  document.getElementById("alert-overlay").classList.add("hidden");
  AppState.activeAlertTask = null;
}

// --- Overdue / Carry Forward Engine ---
function checkOverduePreviousDays() {
  const todayStr = getLocalDateString(new Date());
  const overdueTasks = AppState.tasks.filter(t => t.date < todayStr && t.status !== "completed" && t.status !== "carried");
  const banner = document.getElementById("carry-forward-banner");

  if (overdueTasks.length > 0) {
    document.getElementById("carry-forward-message").textContent = `You have ${overdueTasks.length} pending task${overdueTasks.length > 1 ? 's' : ''} from yesterday!`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

function carryAllForwardToToday() {
  const todayStr = getLocalDateString(new Date());
  const overdueTasks = AppState.tasks.filter(t => t.date < todayStr && t.status !== "completed" && t.status !== "carried");

  if (overdueTasks.length === 0) return;

  if (db && currentUser) {
    const batch = db.batch();
    overdueTasks.forEach(t => {
      const ref = db.collection("users").doc(currentUser.uid).collection("tasks").doc(t.id);
      batch.update(ref, { date: todayStr, carriedFrom: t.date, notified: false });
    });
    batch.commit().then(() => {
      addAssistantMessage(`✅ Carried forward ${overdueTasks.length} task${overdueTasks.length > 1 ? 's' : ''} to today!`);
    }).catch(err => console.error("Batch carry forward failed:", err));
  } else {
    let count = 0;
    AppState.tasks.forEach(t => {
      if (t.date < todayStr && t.status !== "completed" && t.status !== "carried") {
        t.carriedFrom = t.date;
        t.date = todayStr;
        t.notified = false;
        count++;
      }
    });
    if (count > 0) {
      saveState();
      refreshAllViews();
      addAssistantMessage(`✅ Carried forward ${count} task${count > 1 ? 's' : ''} to today!`);
    }
  }
}

function carrySingleForward(taskId) {
  const todayStr = getLocalDateString(new Date());
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  if (db && currentUser) {
    firestoreUpdateTask(taskId, { carriedFrom: task.date, date: todayStr, notified: false })
      .then(() => addAssistantMessage(`🔄 "**${task.title}**" carried forward to today.`))
      .catch(err => console.error("Carry forward failed:", err));
  } else {
    task.carriedFrom = task.date;
    task.date = todayStr;
    task.notified = false;
    saveState();
    refreshAllViews();
    addAssistantMessage(`🔄 "${task.title}" carried forward to today.`);
  }
}

// Helper to refresh all views at once
function refreshAllViews() {
  checkOverduePreviousDays();
  renderTimeline();
  renderCalendar();
  renderSelectedDayPreview();
  updateMetrics();
}

// --- UI Board & Timeline Renderers ---
function renderTimeline() {
  const todoContainer = document.getElementById("todo-tasks-list");
  const chatContainer = document.getElementById("chat-tasks-list");
  if (!todoContainer || !chatContainer) return;

  const todayStr = getLocalDateString(new Date());
  const todayTasks = AppState.tasks.filter(t => t.date === todayStr);

  todayTasks.sort((a, b) => a.time.localeCompare(b.time));

  const now = new Date();
  const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  const todoTasks = todayTasks.filter(t => t.source !== "chat");
  const chatTasks = todayTasks.filter(t => t.source === "chat");

  // Render Todo Column
  if (todoTasks.length === 0) {
    todoContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 8v4l3 3"></path>
        </svg>
        <h4>No Manual Tasks</h4>
        <p>Click '+' above to schedule a task.</p>
      </div>
    `;
  } else {
    todoContainer.innerHTML = "";
    todoTasks.forEach(task => renderTaskCard(todoContainer, task, currentTimeStr));
  }

  // Render Chat Column
  if (chatTasks.length === 0) {
    chatContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 8v4l3 3"></path>
        </svg>
        <h4>No Chat Tasks</h4>
        <p>Ask the assistant to schedule a task.</p>
      </div>
    `;
  } else {
    chatContainer.innerHTML = "";
    chatTasks.forEach(task => renderTaskCard(chatContainer, task, currentTimeStr));
  }
}

function renderTaskCard(container, task, currentTimeStr) {
  let statusClass = "pending";
  if (task.status === "completed") {
    statusClass = "completed";
  } else if (task.status === "pushed") {
    statusClass = "pushed";
  } else if (task.date === getLocalDateString(new Date()) && task.time < currentTimeStr) {
    statusClass = "overdue";
  } else if (task.notified) {
    statusClass = "active";
  }

  const [h, m] = task.time.split(":");
  const ampm = h >= 12 ? "PM" : "AM";
  const displayTime = `${h % 12 || 12}:${m} ${ampm}`;

  const item = document.createElement("div");
  item.className = `timeline-item ${statusClass}`;
  if (task.carriedFrom) item.classList.add("carried");

  item.innerHTML = `
    <div class="timeline-marker">
      <div class="marker-node"></div>
    </div>
    <div class="task-card">
      <div class="task-main-info">
        <label class="task-checkbox-container">
          <input type="checkbox" ${task.status === 'completed' ? 'checked' : ''} onchange="toggleTaskComplete('${task.id}')">
          <span class="checkmark"></span>
        </label>
        <div class="task-text">
          <h4 class="${task.status === 'completed' ? 'completed-text' : ''}">${task.title}</h4>
          <div class="task-meta-row">
            <span class="task-time-pill">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <polyline points="12 6 12 12 16 14"></polyline>
              </svg>
              ${displayTime}
            </span>
            <div class="task-notion-tags">
              <span class="notion-tag status-${task.status}" onclick="showStatusDropdown('${task.id}', event)">${statusLabels[task.status] || task.status}</span>
              <span class="notion-tag prio-${task.priority}" onclick="showPriorityDropdown('${task.id}', event)">${priorityLabels[task.priority] || task.priority}</span>
            </div>
            ${task.carriedFrom ? `
              <span class="carried-badge" title="Carried from ${task.carriedFrom}">
                <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5">
                  <polyline points="23 4 23 10 17 10"></polyline>
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                </svg>
                Carried
              </span>` : ''}
          </div>
        </div>
      </div>
      <div class="task-actions">
        <button class="task-action-btn btn-reschedule-task" onclick="openRescheduleModal('${task.id}')" title="Reschedule Task">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </button>
        <button class="task-action-btn btn-delete-task" onclick="deleteTask('${task.id}')" title="Delete Task">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
        </button>
      </div>
    </div>
  `;
  container.appendChild(item);
}

function showStatusDropdown(taskId, event) {
  event.stopPropagation();
  event.preventDefault();

  const existing = document.querySelector(".notion-dropdown");
  if (existing) {
    existing.remove();
  }

  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  const rect = event.currentTarget.getBoundingClientRect();

  const dropdown = document.createElement("div");
  dropdown.className = "notion-dropdown";
  dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
  dropdown.style.left = `${rect.left + window.scrollX}px`;

  const statuses = [
    { value: "not-started", label: "Not Started", icon: "⚪" },
    { value: "in-progress", label: "In Progress", icon: "🟡" },
    { value: "completed", label: "Completed", icon: "🟢" },
    { value: "pushed", label: "Pushed to Tomorrow", icon: "🟣" }
  ];

  statuses.forEach(s => {
    const item = document.createElement("button");
    item.className = "notion-dropdown-item";
    if (task.status === s.value) {
      item.classList.add("active");
    }
    item.innerHTML = `<span>${s.icon}</span> <span>${s.label}</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      updateTaskStatus(taskId, s.value);
      dropdown.remove();
    });
    dropdown.appendChild(item);
  });

  document.body.appendChild(dropdown);
}

function showPriorityDropdown(taskId, event) {
  event.stopPropagation();
  event.preventDefault();

  const existing = document.querySelector(".notion-dropdown");
  if (existing) {
    existing.remove();
  }

  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  const rect = event.currentTarget.getBoundingClientRect();

  const dropdown = document.createElement("div");
  dropdown.className = "notion-dropdown";
  dropdown.style.top = `${rect.bottom + window.scrollY + 4}px`;
  dropdown.style.left = `${rect.left + window.scrollX}px`;

  const priorities = [
    { value: "low", label: "Low Priority", icon: "🔵" },
    { value: "medium", label: "Medium Priority", icon: "🔴" },
    { value: "high", label: "High Priority", icon: "⚡" }
  ];

  priorities.forEach(p => {
    const item = document.createElement("button");
    item.className = "notion-dropdown-item";
    if (task.priority === p.value) {
      item.classList.add("active");
    }
    item.innerHTML = `<span>${p.icon}</span> <span>${p.label}</span>`;
    item.addEventListener("click", (e) => {
      e.stopPropagation();
      updateTaskPriority(taskId, p.value);
      dropdown.remove();
    });
    dropdown.appendChild(item);
  });

  document.body.appendChild(dropdown);
}

function updateTaskStatus(taskId, newStatus) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  if (newStatus === "pushed") {
    const currentTaskDate = task.date;
    const nextDay = new Date(currentTaskDate + "T00:00:00");
    nextDay.setDate(nextDay.getDate() + 1);
    const nextDayStr = getLocalDateString(nextDay);

    const updates = {
      date: nextDayStr,
      status: "pushed",
      carriedFrom: currentTaskDate
    };

    if (db && currentUser) {
      firestoreUpdateTask(taskId, updates)
        .then(() => {
          addAssistantMessage(`🔄 Pushed task "**${task.title}**" to tomorrow (${nextDayStr}).`);
        })
        .catch(err => console.error("Push task failed:", err));
    } else {
      task.date = nextDayStr;
      task.status = "pushed";
      task.carriedFrom = currentTaskDate;
      saveState();
      refreshAllViews();
      addAssistantMessage(`🔄 Pushed task "${task.title}" to tomorrow (${nextDayStr}).`);
    }
    return;
  }

  const nextNotified = (newStatus === "completed") ? task.notified : false;

  const updates = {
    status: newStatus,
    notified: nextNotified
  };

  if (db && currentUser) {
    firestoreUpdateTask(taskId, updates)
      .then(() => {
        if (newStatus === "completed") {
          addAssistantMessage(`🎉 Great job completing "**${task.title}**"!`);
        }
      })
      .catch(err => console.error("Update status failed:", err));
  } else {
    task.status = newStatus;
    task.notified = nextNotified;
    saveState();
    refreshAllViews();
    if (newStatus === "completed") {
      addAssistantMessage(`🎉 Great job completing "${task.title}"!`);
    }
  }
}

// --- Toggle Tasks completed status ---
function toggleTaskComplete(taskId) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  const nextStatus = (task.status === "completed") ? "not-started" : "completed";
  let nextNotified = task.notified;

  if (nextStatus === "not-started") {
    const now = new Date();
    const todayStr = getLocalDateString(now);
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (task.date > todayStr || (task.date === todayStr && task.time > currentTimeStr)) {
      nextNotified = false;
    }
  }

  if (db && currentUser) {
    firestoreUpdateTask(taskId, { status: nextStatus, notified: nextNotified })
      .then(() => {
        if (nextStatus === "completed") {
          addAssistantMessage(`🎉 Great job completing "**${task.title}**"!`);
        }
      })
      .catch(err => console.error("Toggle complete failed:", err));
  } else {
    task.status = nextStatus;
    task.notified = nextNotified;
    saveState();
    refreshAllViews();
    if (task.status === "completed") {
      addAssistantMessage(`🎉 Great job completing "${task.title}"!`);
    }
  }
}

function updateTaskPriority(taskId, newPriority) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  const updates = { priority: newPriority };

  if (db && currentUser) {
    firestoreUpdateTask(taskId, updates)
      .catch(err => console.error("Update priority failed:", err));
  } else {
    task.priority = newPriority;
    saveState();
    refreshAllViews();
  }
}

// --- Delete task ---
function deleteTask(taskId) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  if (db && currentUser) {
    firestoreDeleteTask(taskId)
      .then(() => addAssistantMessage(`🗑️ Deleted: "**${task.title}**" removed.`))
      .catch(err => console.error("Delete task failed:", err));
  } else {
    const index = AppState.tasks.findIndex(t => t.id === taskId);
    AppState.tasks.splice(index, 1);
    saveState();
    refreshAllViews();
    addAssistantMessage(`🗑️ Deleted: "${task.title}" removed.`);
  }
}

// --- Render Monthly Calendar Widget ---
function initCalendar() {
  const today = new Date();
  AppState.currentCalendarMonth = today.getMonth();
  AppState.currentCalendarYear = today.getFullYear();
  AppState.selectedCalendarDate = today;
}

function renderCalendar() {
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  const calTitle = document.getElementById("cal-month-year");
  const calGrid = document.getElementById("calendar-grid");

  calTitle.textContent = `${monthNames[AppState.currentCalendarMonth]} ${AppState.currentCalendarYear}`;
  calGrid.innerHTML = "";

  const firstDay = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth, 1);
  const startDayOfWeek = firstDay.getDay();
  const daysInMonth = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth, 0).getDate();

  const today = new Date();
  const todayStr = getLocalDateString(today);
  const selectedStr = getLocalDateString(AppState.selectedCalendarDate);

  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.textContent = daysInPrevMonth - i;
    calGrid.appendChild(cell);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const currentCellDate = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth, day);
    const dateStr = getLocalDateString(currentCellDate);

    const cell = document.createElement("div");
    cell.className = "calendar-day-cell";
    cell.textContent = day;

    if (dateStr === todayStr) cell.classList.add("today");
    if (dateStr === selectedStr) cell.classList.add("selected");

    const dateTasks = AppState.tasks.filter(t => t.date === dateStr);
    if (dateTasks.length > 0) {
      const dotContainer = document.createElement("div");
      dotContainer.className = "day-dots-container";
      const maxDots = Math.min(dateTasks.length, 3);
      for (let k = 0; k < maxDots; k++) {
        const dot = document.createElement("span");
        dot.className = "day-dot";
        if (dateTasks[k].status === "completed") dot.classList.add("dot-completed");
        else if (dateTasks[k].priority === "high") dot.classList.add("dot-high");
        dotContainer.appendChild(dot);
      }
      cell.appendChild(dotContainer);
    }

    cell.addEventListener("click", () => {
      AppState.selectedCalendarDate = currentCellDate;
      renderCalendar();
      renderSelectedDayPreview();
    });

    calGrid.appendChild(cell);
  }

  const totalCellsFilled = startDayOfWeek + daysInMonth;
  const trailingCellsNeeded = 42 - totalCellsFilled;
  for (let day = 1; day <= trailingCellsNeeded; day++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.textContent = day;
    calGrid.appendChild(cell);
  }
}

function navigateCalendar(direction) {
  AppState.currentCalendarMonth += direction;
  if (AppState.currentCalendarMonth < 0) {
    AppState.currentCalendarMonth = 11;
    AppState.currentCalendarYear--;
  } else if (AppState.currentCalendarMonth > 11) {
    AppState.currentCalendarMonth = 0;
    AppState.currentCalendarYear++;
  }
  renderCalendar();
}

// --- Render Selected Day Tasks Preview Panel ---
function renderSelectedDayPreview() {
  const container = document.getElementById("day-preview-list");
  const title = document.getElementById("preview-date-title");
  const selectedStr = getLocalDateString(AppState.selectedCalendarDate);

  const prettyDate = AppState.selectedCalendarDate.toLocaleDateString([], {
    weekday: 'long', month: 'short', day: 'numeric', year: 'numeric'
  });
  title.textContent = `Tasks for ${prettyDate}`;

  const filtered = AppState.tasks.filter(t => t.date === selectedStr);

  if (filtered.length === 0) {
    container.innerHTML = `<p class="empty-state-text">No tasks scheduled for this day.</p>`;
    return;
  }

  filtered.sort((a, b) => a.time.localeCompare(b.time));
  container.innerHTML = "";

  const now = new Date();
  const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  filtered.forEach(task => {
    renderTaskCard(container, task, currentTimeStr);
  });
}

// --- Update Dashboard Stats & Counters ---
function updateMetrics() {
  const todayStr = getLocalDateString(new Date());
  const pending = AppState.tasks.filter(t => t.date === todayStr && t.status === "pending").length;
  const completed = AppState.tasks.filter(t => t.status === "completed").length;
  const carried = AppState.tasks.filter(t => t.carriedFrom).length;

  document.getElementById("stats-pending").textContent = pending;
  document.getElementById("stats-completed").textContent = completed;
  document.getElementById("stats-carried").textContent = carried;
}

// --- Modal Add Task Panel Handlers ---
function openAddTaskModal() {
  const overlay = document.getElementById("task-modal-overlay");
  const now = new Date();
  document.getElementById("task-date").value = getLocalDateString(AppState.selectedCalendarDate || now);

  const fut = new Date(now.getTime() + 5 * 60 * 1000);
  document.getElementById("task-time").value = `${String(fut.getHours()).padStart(2, '0')}:${String(fut.getMinutes()).padStart(2, '0')}`;

  document.getElementById("task-title").value = "";
  document.getElementById("task-priority").value = "medium";
  document.getElementById("task-repeat").value = "none";

  overlay.classList.remove("hidden");
  document.getElementById("task-title").focus();
}

function closeAddTaskModal() {
  document.getElementById("task-modal-overlay").classList.add("hidden");
}

function handleAddTaskSubmit(e) {
  e.preventDefault();

  const title = document.getElementById("task-title").value.trim();
  const date = document.getElementById("task-date").value;
  const time = document.getElementById("task-time").value;
  const priority = document.getElementById("task-priority").value;
  const status = document.getElementById("task-status").value;
  const repeat = document.getElementById("task-repeat").value;
  const reminderSchedule = document.getElementById("task-reminder-schedule").value;
  const source = AppState.modalSource || "manual";

  if (title && date && time) {
    const randomSuffix = Math.random().toString(36).substring(2, 7);
    const newTask = {
      id: "task-" + Date.now() + "-" + randomSuffix,
      title, date, time, priority, repeat, status, reminderSchedule,
      source: source,
      notified: false,
      dueTimestamp: getTaskTimestamp(date, time)
    };

    if (db && currentUser) {
      firestoreSaveTask(newTask)
        .then(() => {
          closeAddTaskModal();
          addAssistantMessage(`📝 Scheduled: "**${title}**" on ${date} at ${time}.`);
        })
        .catch(err => console.error("Add task failed:", err));
    } else {
      AppState.tasks.push(newTask);
      saveState();
      closeAddTaskModal();
      refreshAllViews();
      addAssistantMessage(`📝 Scheduled: "${title}" on ${date} at ${time}.`);
    }
  }
}

// --- Markdown Formatter Helper ---
function formatMarkdown(text) {
  if (!text) return "";
  return text
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code>$1</code>');
}

// --- Personal Assistant Interaction (Chat Console) ---
function renderChatHistory() {
  const log = document.getElementById("pa-chat-log");
  if (!log) return;
  log.innerHTML = "";

  const history = AppState.chatHistory || [];
  if (history.length === 0) {
    const defaultGreetings = [
      { sender: "assistant", text: "Hello! I'm Kairos, your Personal Assistant. You can add tasks manually or type commands to me below!" },
      { sender: "assistant", text: "Try typing: `water flowers at 15:00, meeting at 16:00` to schedule multiple tasks at once." }
    ];
    defaultGreetings.forEach(msg => drawMessageInLog(msg));
  } else {
    history.forEach(msg => drawMessageInLog(msg));
  }
}

function addAssistantMessage(text, className = "") {
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgId = "msg-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);
  const msgObj = { id: msgId, sender: "assistant", text: text, className: className, time: timeStr, timestamp: Date.now() };

  if (db && currentUser) {
    db.collection("users").doc(currentUser.uid).collection("chatHistory").doc(msgId).set(msgObj)
      .catch(err => console.error("Save assistant message failed:", err));
  } else {
    if (!AppState.chatHistory) AppState.chatHistory = [];
    AppState.chatHistory.push(msgObj);
    saveState();
    drawMessageInLog(msgObj);
  }
}

function addUserMessage(text) {
  const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const msgId = "msg-" + Date.now() + "-" + Math.random().toString(36).substring(2, 7);
  const msgObj = { id: msgId, sender: "user", text: text, time: timeStr, timestamp: Date.now() };

  if (db && currentUser) {
    db.collection("users").doc(currentUser.uid).collection("chatHistory").doc(msgId).set(msgObj)
      .catch(err => console.error("Save user message failed:", err));
  } else {
    if (!AppState.chatHistory) AppState.chatHistory = [];
    AppState.chatHistory.push(msgObj);
    saveState();
    drawMessageInLog(msgObj);
  }
}

// --- Personal Assistant Conversational Command Parser ---
function handleAssistantCommand(e) {
  e.preventDefault();
  const input = document.getElementById("pa-command-input");
  const commandText = input.value.trim();
  if (!commandText) return;

  addUserMessage(commandText);
  input.value = "";

  setTimeout(() => {
    parseCommand(commandText);
  }, 400);
}

function extractTime(text) {
  let timeStr = "";
  let isRelative = false;
  let delayMinutes = 0;
  let cleanedText = text.trim();

  // 1. Check for Relative Time
  const relativeRegex = /\b(?:in|after)\s+(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i;
  const relativeMatch = cleanedText.match(relativeRegex);

  if (relativeMatch) {
    isRelative = true;
    const quantity = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    let multiplier = 1;
    if (unit.startsWith("hour") || unit.startsWith("hr")) multiplier = 60;
    delayMinutes = quantity * multiplier;
    const targetTime = new Date(Date.now() + delayMinutes * 60 * 1000);
    timeStr = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
    cleanedText = cleanedText.replace(relativeRegex, "").trim();
  } else {
    // 2. Check for Absolute Time
    const absoluteRegex = /\b(?:at|for|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b$/i;
    const absoluteMatch = cleanedText.match(absoluteRegex);

    if (absoluteMatch) {
      let hour = parseInt(absoluteMatch[1]);
      const minute = absoluteMatch[2] || "00";
      const ampm = absoluteMatch[3] ? absoluteMatch[3].toLowerCase() : null;
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      timeStr = `${String(hour).padStart(2, '0')}:${minute}`;
      cleanedText = cleanedText.replace(absoluteRegex, "").trim();
    }
  }

  return { timeStr, isRelative, delayMinutes, cleanedText };
}

function cleanTaskTitle(text) {
  const prefixes = [
    /^(?:remind me to|remind me|remind|add task|add|todo|schedule|alert)\s+/i,
    /^(?:to|for|at|in)\s+/i
  ];
  let cleaned = text.trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const regex of prefixes) {
      const replaced = cleaned.replace(regex, "");
      if (replaced !== cleaned) { cleaned = replaced.trim(); changed = true; }
    }
  }
  cleaned = cleaned.replace(/^(?:to|for|at|in|by)\s+/i, "").trim();
  cleaned = cleaned.replace(/\s+(?:to|for|at|in|by)$/i, "").trim();
  return cleaned || "Reminder";
}

function extractDate(text) {
  let dateStr = getLocalDateString(new Date());
  let cleanedText = text.trim();

  // 1. YYYY-MM-DD
  const ymdRegex = /\b(\d{4})-(\d{2})-(\d{2})\b/;
  const ymdMatch = cleanedText.match(ymdRegex);
  if (ymdMatch) {
    dateStr = `${ymdMatch[1]}-${ymdMatch[2]}-${ymdMatch[3]}`;
    cleanedText = cleanedText.replace(ymdRegex, "").trim();
    return { dateStr, cleanedText };
  }

  // 2. Month words: e.g. "on 22 September" or "on September 22" or "on Sept 22"
  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  
  const wordDateRegex1 = /\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;
  const wordDateMatch1 = cleanedText.match(wordDateRegex1);
  if (wordDateMatch1) {
    const day = parseInt(wordDateMatch1[1]);
    const monthIndex = monthNames.indexOf(wordDateMatch1[2].toLowerCase().substring(0, 3));
    if (monthIndex !== -1) {
      const year = new Date().getFullYear();
      const dateVal = new Date(year, monthIndex, day);
      dateStr = getLocalDateString(dateVal);
      cleanedText = cleanedText.replace(wordDateRegex1, "").trim();
      return { dateStr, cleanedText };
    }
  }

  const wordDateRegex2 = /\b(?:on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
  const wordDateMatch2 = cleanedText.match(wordDateRegex2);
  if (wordDateMatch2) {
    const day = parseInt(wordDateMatch2[2]);
    const monthIndex = monthNames.indexOf(wordDateMatch2[1].toLowerCase().substring(0, 3));
    if (monthIndex !== -1) {
      const year = new Date().getFullYear();
      const dateVal = new Date(year, monthIndex, day);
      dateStr = getLocalDateString(dateVal);
      cleanedText = cleanedText.replace(wordDateRegex2, "").trim();
      return { dateStr, cleanedText };
    }
  }

  return { dateStr, cleanedText };
}

function createAndSaveTask(title, timeStr, isRelative, delayMinutes, reminderSchedule = "once", taskDate = null, source = "chat") {
  const todayStr = getLocalDateString(new Date());
  const dateStr = taskDate || todayStr;
  const randomSuffix = Math.random().toString(36).substring(2, 7);
  const newTask = {
    id: "task-" + Date.now() + "-" + randomSuffix,
    title: title,
    date: dateStr,
    time: timeStr,
    priority: "medium",
    status: "not-started",
    source: source,
    reminderSchedule: reminderSchedule,
    notified: false,
    dueTimestamp: getTaskTimestamp(dateStr, timeStr)
  };

  if (db && currentUser) {
    firestoreSaveTask(newTask)
      .catch(err => console.error("Command add task failed:", err));
  } else {
    AppState.tasks.push(newTask);
    saveState();
    refreshAllViews();
  }

  const columnLabel = source === "manual" ? "Todo List" : "Conversations";
  if (isRelative) {
    addAssistantMessage(`✍️ Reminder set in **${columnLabel}**: "**${title}**" in ${delayMinutes} minutes (at ${timeStr}).`);
  } else {
    const dateLabel = (dateStr === todayStr) ? "today" : `on ${dateStr}`;
    const scheduleLabel = (reminderSchedule !== "once") ? ` (Alert: ${reminderSchedule === "daily-lead" ? "daily" : "weekly"} leading up)` : "";
    addAssistantMessage(`📅 Scheduled in **${columnLabel}**: "**${title}**" ${dateLabel} at ${timeStr}${scheduleLabel}.`);
  }
}

function parseCommand(cmd) {
  let text = cmd.trim();
  if (!text) return;

  // Detect routing prefix and strip it
  let isManualSource = false;
  const manualPrefixRegex = /^\b(?:add\s+tasks|add\s+task|add\s+todos|add\s+todo|add|todos|todo|tasks|task|schedule\s+tasks|schedule\s+task|schedule)\b\s*:?\s*/i;
  
  if (manualPrefixRegex.test(text)) {
    isManualSource = true;
    text = text.replace(manualPrefixRegex, "").trim();
  } else {
    const remindPrefixRegex = /^\b(?:remind\s+me\s+to|remind\s+me|remind|reminder)\b\s*:?\s*/i;
    if (remindPrefixRegex.test(text)) {
      text = text.replace(remindPrefixRegex, "").trim();
    }
  }

  const taskSource = isManualSource ? "manual" : "chat";

  // 1. Check for Reminder Schedule keywords (daily, weekly leading up)
  let reminderSchedule = "once";
  if (/\b(?:daily reminder|remind daily|daily alert|every day)\b/i.test(text)) {
    reminderSchedule = "daily-lead";
    text = text.replace(/\b(?:daily reminder|remind daily|daily alert|every day)\b/i, "").trim();
  } else if (/\b(?:weekly reminder|remind weekly|weekly alert|every week)\b/i.test(text)) {
    reminderSchedule = "weekly-lead";
    text = text.replace(/\b(?:weekly reminder|remind weekly|weekly alert|every week)\b/i, "").trim();
  }

  // 2. Extract Date (defaults to today's date if not parsed)
  const dateInfo = extractDate(text);
  const taskDate = dateInfo.dateStr;
  text = dateInfo.cleanedText;

  // Split by comma or semicolon
  const separators = /[;,]+/;
  const parts = text.split(separators).map(p => p.trim()).filter(Boolean);

  if (parts.length > 1) {
    // Multiple tasks!
    let inheritedTimeStr = "";
    let inheritedIsRelative = false;
    let inheritedDelayMinutes = 0;

    // Scan backwards to find the last specified time
    for (let i = parts.length - 1; i >= 0; i--) {
      const partInfo = extractTime(parts[i]);
      if (partInfo.timeStr) {
        inheritedTimeStr = partInfo.timeStr;
        inheritedIsRelative = partInfo.isRelative;
        inheritedDelayMinutes = partInfo.delayMinutes;
        break;
      }
    }

    // Default to 1 hour from now if no time was specified in any part
    if (!inheritedTimeStr) {
      const targetTime = new Date(Date.now() + 60 * 60 * 1000);
      inheritedTimeStr = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
      inheritedIsRelative = true;
      inheritedDelayMinutes = 60;
    }

    // Parse and create each task
    parts.forEach(part => {
      const partInfo = extractTime(part);
      const timeStr = partInfo.timeStr || inheritedTimeStr;
      const isRelative = partInfo.timeStr ? partInfo.isRelative : inheritedIsRelative;
      const delayMinutes = partInfo.timeStr ? partInfo.delayMinutes : inheritedDelayMinutes;
      
      const cleanedTitle = cleanTaskTitle(partInfo.cleanedText);
      createAndSaveTask(cleanedTitle, timeStr, isRelative, delayMinutes, reminderSchedule, taskDate, taskSource);
    });
  } else {
    // Single task
    const partInfo = extractTime(text);
    let timeStr = partInfo.timeStr;
    let isRelative = partInfo.isRelative;
    let delayMinutes = partInfo.delayMinutes;

    if (!timeStr) {
      const targetTime = new Date(Date.now() + 60 * 60 * 1000);
      timeStr = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
      isRelative = true;
      delayMinutes = 60;
    }

    const cleanedTitle = cleanTaskTitle(partInfo.cleanedText);
    createAndSaveTask(cleanedTitle, timeStr, isRelative, delayMinutes, reminderSchedule, taskDate, taskSource);
  }
}

// --- Mobile Sidebar Toggle ---
function toggleSidebar(forceState) {
  const sidebar = document.getElementById("pa-sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");

  if (forceState === false || sidebar.classList.contains("open")) {
    sidebar.classList.remove("open");
    backdrop.classList.remove("visible");
    document.body.classList.remove("sidebar-open");
  } else {
    sidebar.classList.add("open");
    backdrop.classList.add("visible");
    document.body.classList.add("sidebar-open");
    // Focus the chat input when opening
    setTimeout(() => {
      document.getElementById("pa-command-input").focus();
    }, 300);
  }
}

// --- Event Listeners and Button Bindings ---
function initEventListeners() {
  // Calendar Nav
  document.getElementById("cal-prev-btn").addEventListener("click", () => navigateCalendar(-1));
  document.getElementById("cal-next-btn").addEventListener("click", () => navigateCalendar(1));

  // Notification Enable button
  document.getElementById("notification-toggle-btn").addEventListener("click", () => requestNotificationPermission(false));

  // Add Task Modal buttons
  document.getElementById("add-task-modal-btn").addEventListener("click", () => {
    AppState.modalSource = "manual";
    openAddTaskModal();
  });
  const addChatBtn = document.getElementById("add-chat-task-modal-btn");
  if (addChatBtn) {
    addChatBtn.addEventListener("click", () => {
      AppState.modalSource = "chat";
      openAddTaskModal();
    });
  }
  document.getElementById("task-modal-close").addEventListener("click", closeAddTaskModal);
  document.getElementById("task-modal-cancel").addEventListener("click", closeAddTaskModal);
  document.getElementById("task-modal-form").addEventListener("submit", handleAddTaskSubmit);

  // PA Command box
  document.getElementById("pa-command-form").addEventListener("submit", handleAssistantCommand);

  // Carry Forward Banner
  document.getElementById("carry-all-forward-btn").addEventListener("click", carryAllForwardToToday);

  // Profile dropdown toggler
  const profileBtn = document.getElementById("profile-dropdown-btn");
  const profileDropdown = document.getElementById("profile-dropdown");
  if (profileBtn && profileDropdown) {
    profileBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      profileDropdown.classList.toggle("hidden");
    });
    profileDropdown.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => {
      profileDropdown.classList.add("hidden");
    });
  }

  // "Sign In / Sign Up" button in dropdown — opens the auth overlay
  const authOpenBtn = document.getElementById("auth-open-btn");
  if (authOpenBtn) {
    authOpenBtn.addEventListener("click", () => {
      profileDropdown.classList.add("hidden");
      document.getElementById("auth-overlay").classList.remove("hidden");
      // Show login form by default when opening from dropdown
      document.getElementById("auth-login-form").classList.remove("hidden");
      document.getElementById("auth-signup-form").classList.add("hidden");
    });
  }

  // Mobile sidebar toggle
  document.getElementById("mobile-menu-btn").addEventListener("click", () => toggleSidebar());
  document.getElementById("sidebar-close-btn").addEventListener("click", () => toggleSidebar(false));
  document.getElementById("sidebar-backdrop").addEventListener("click", () => toggleSidebar(false));
  document.getElementById("mobile-chat-fab").addEventListener("click", () => toggleSidebar());

  // Clear chat button
  const clearChatBtn = document.getElementById("clear-chat-btn");
  if (clearChatBtn) {
    clearChatBtn.addEventListener("click", () => {
      if (db && currentUser) {
        db.collection("users").doc(currentUser.uid).collection("chatHistory").get()
          .then(snapshot => {
            const batch = db.batch();
            snapshot.forEach(doc => {
              batch.delete(doc.ref);
            });
            return batch.commit();
          })
          .then(() => {
            addAssistantMessage("🧹 Chat logs cleared.");
          })
          .catch(err => console.error("Clear online chat history failed:", err));
      } else {
        AppState.chatHistory = [];
        saveState();
        renderChatHistory();
        addAssistantMessage("🧹 Chat logs cleared.");
      }
    });
  }

  // Auth modal close button
  const authCloseBtn = document.getElementById("auth-close-btn");
  if (authCloseBtn) {
    authCloseBtn.addEventListener("click", () => {
      document.getElementById("auth-overlay").classList.add("hidden");
    });
  }


  // Reschedule modal
  document.getElementById("reschedule-modal-close").addEventListener("click", closeRescheduleModal);
  document.getElementById("reschedule-modal-cancel").addEventListener("click", closeRescheduleModal);
  document.getElementById("reschedule-modal-form").addEventListener("submit", handleRescheduleSubmit);

  // Alert overlay actions
  document.getElementById("alert-complete-btn").addEventListener("click", () => {
    if (AppState.activeAlertTask) toggleTaskComplete(AppState.activeAlertTask.id);
    hideInAppAlertModal();
  });

  document.getElementById("alert-postpone-btn").addEventListener("click", () => {
    if (AppState.activeAlertTask) {
      const task = AppState.activeAlertTask;
      const [h, m] = task.time.split(":");
      const d = new Date();
      d.setHours(parseInt(h));
      d.setMinutes(parseInt(m) + 15);
      const newTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

      if (db && currentUser) {
        firestoreUpdateTask(task.id, { time: newTime, notified: false, dueTimestamp: getTaskTimestamp(task.date, newTime) })
          .then(() => addAssistantMessage(`🕒 Postponed: "**${task.title}**" by 15 mins.`));
      } else {
        task.time = newTime;
        task.notified = false;
        saveState();
        refreshAllViews();
        addAssistantMessage(`🕒 Postponed: "${task.title}" by 15 mins.`);
      }
    }
    hideInAppAlertModal();
  });

  document.getElementById("alert-carry-btn").addEventListener("click", () => {
    if (AppState.activeAlertTask) {
      const task = AppState.activeAlertTask;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = getLocalDateString(tomorrow);

      if (db && currentUser) {
        firestoreUpdateTask(task.id, { carriedFrom: task.date, date: tomorrowStr, notified: false })
          .then(() => addAssistantMessage(`🔄 "**${task.title}**" carried to tomorrow.`));
      } else {
        task.carriedFrom = task.date;
        task.date = tomorrowStr;
        task.notified = false;
        saveState();
        refreshAllViews();
        addAssistantMessage(`🔄 "${task.title}" carried to tomorrow.`);
      }
    }
    hideInAppAlertModal();
  });

  const dismissBtn = document.getElementById("alert-dismiss-btn");
  if (dismissBtn) {
    dismissBtn.addEventListener("click", hideInAppAlertModal);
  }

  const previewAddBtn = document.getElementById("add-task-from-preview-btn");
  if (previewAddBtn) {
    previewAddBtn.addEventListener("click", () => {
      AppState.modalSource = "manual";
      openAddTaskModal();
    });
  }

  const sidebarCollapseBtn = document.getElementById("sidebar-collapse-btn");
  if (sidebarCollapseBtn) {
    sidebarCollapseBtn.addEventListener("click", () => {
      document.body.classList.add("sidebar-collapsed");
      if (!AppState.preferences) {
        AppState.preferences = {};
      }
      AppState.preferences.sidebarCollapsed = true;
      saveState();
    });
  }

  const desktopSidebarToggle = document.getElementById("desktop-sidebar-toggle-btn");
  if (desktopSidebarToggle) {
    desktopSidebarToggle.addEventListener("click", () => {
      document.body.classList.remove("sidebar-collapsed");
      if (!AppState.preferences) {
        AppState.preferences = {};
      }
      AppState.preferences.sidebarCollapsed = false;
      saveState();
    });
  }

  document.addEventListener("click", () => {
    const existing = document.querySelector(".notion-dropdown");
    if (existing) {
      existing.remove();
    }
  });
}

// --- Reschedule Single Task Modal handlers ---
function openRescheduleModal(taskId) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (task) {
    document.getElementById("reschedule-task-id").value = task.id;
    document.getElementById("reschedule-task-title-text").textContent = task.title;
    document.getElementById("reschedule-date").value = task.date;
    document.getElementById("reschedule-time").value = task.time;
    document.getElementById("reschedule-modal-overlay").classList.remove("hidden");
  }
}

function closeRescheduleModal() {
  document.getElementById("reschedule-modal-overlay").classList.add("hidden");
}

function handleRescheduleSubmit(e) {
  e.preventDefault();
  const taskId = document.getElementById("reschedule-task-id").value;
  const date = document.getElementById("reschedule-date").value;
  const time = document.getElementById("reschedule-time").value;

  const task = AppState.tasks.find(t => t.id === taskId);
  if (task && date && time) {
    let nextNotified = task.notified;
    const now = new Date();
    const todayStr = getLocalDateString(now);
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (date > todayStr || (date === todayStr && time > currentTimeStr)) {
      nextNotified = false;
    }

    if (db && currentUser) {
      firestoreUpdateTask(taskId, { date, time, notified: nextNotified, dueTimestamp: getTaskTimestamp(date, time) })
        .then(() => {
          closeRescheduleModal();
          addAssistantMessage(`🔄 Rescheduled: "**${task.title}**" to ${date} at ${time}.`);
        })
        .catch(err => console.error("Reschedule failed:", err));
    } else {
      task.date = date;
      task.time = time;
      task.notified = nextNotified;
      saveState();
      closeRescheduleModal();
      refreshAllViews();
      addAssistantMessage(`🔄 Rescheduled: "${task.title}" to ${date} at ${time}.`);
    }
  }
}

// --- Date and Time Helper Functions ---
function getLocalDateString(date) {
  const offset = date.getTimezoneOffset();
  const adjustedDate = new Date(date.getTime() - (offset * 60 * 1000));
  return adjustedDate.toISOString().split('T')[0];
}

function getRelativeDateStr(daysDiff) {
  const d = new Date();
  d.setDate(d.getDate() + daysDiff);
  return getLocalDateString(d);
}

function getRelativeTimeStr(minsDiff) {
  const d = new Date(Date.now() + minsDiff * 60 * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// Register Service Worker for push notifications
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('firebase-messaging-sw.js')
      .then(registration => {
        console.log('Service Worker registered:', registration.scope);
        const sendConfig = () => {
          if (navigator.serviceWorker.controller && firebaseConfig) {
            navigator.serviceWorker.controller.postMessage({
              type: 'INIT_FIREBASE',
              config: firebaseConfig
            });
          }
        };
        if (navigator.serviceWorker.controller) {
          sendConfig();
        } else {
          navigator.serviceWorker.addEventListener('controllerchange', sendConfig);
        }
      })
      .catch(err => console.warn('Service Worker registration failed:', err));
  }
}
