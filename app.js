/* ==========================================================================
   ChronosPA Javascript - Application Logic, Firebase Sync, Notifications
   ========================================================================== */

// --- Firebase Configuration Variables ---
let firebaseConfig = null;
let db = null;
let auth = null;
let fcmMessaging = null;  // Firebase Cloud Messaging for push notifications
let userTasksUnsubscribe = null;
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
    notificationPermission: null
  },
  currentCalendarMonth: new Date().getMonth(),
  currentCalendarYear: new Date().getFullYear(),
  selectedCalendarDate: new Date(),
  activeAlertTask: null
};

// --- Constant Priority Mappings ---
const PriorityLabel = {
  low: "Low Priority",
  medium: "Medium Priority",
  high: "HIGH PRIORITY"
};

// --- On Initial Load ---
document.addEventListener("DOMContentLoaded", async () => {
  initClock();
  initCalendar();
  initEventListeners();
  requestNotificationPermission(true); // check status silently

  const configLoaded = await loadFirebaseConfig();
  firebaseActive = configLoaded && initFirebase();

  if (!firebaseActive) {
    // No Firebase config — silently skip sign-in and go straight to the app
    document.getElementById("auth-overlay").classList.add("hidden");
    loadState();
    checkOverduePreviousDays();
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
  } else {
    // Firebase is active — set up auth and real-time sync
    initFirebaseAuth();
    registerServiceWorker();
  }
});

// --- LocalStorage Persistence (fallback when no Firebase) ---
function saveState() {
  if (!firebaseActive || !currentUser) {
    localStorage.setItem("ChronosPA_State", JSON.stringify(AppState));
  }
}

function loadState() {
  const saved = localStorage.getItem("ChronosPA_State");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      AppState.tasks = (parsed.tasks || []).filter(t => !t.id.startsWith("demo-"));
      AppState.preferences = parsed.preferences || AppState.preferences;
    } catch (e) {
      console.error("Error loading localStorage state:", e);
    }
  } else {
    AppState.tasks = [];
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
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errorEl = document.getElementById("login-error");

    errorEl.classList.add("hidden");
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
    const name = document.getElementById("signup-name").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const password = document.getElementById("signup-password").value;
    const errorEl = document.getElementById("signup-error");

    errorEl.classList.add("hidden");
    auth.createUserWithEmailAndPassword(email, password)
      .then((userCredential) => {
        const user = userCredential.user;
        return user.updateProfile({ displayName: name });
      })
      .then(() => {
        document.getElementById("signup-name").value = "";
        document.getElementById("signup-email").value = "";
        document.getElementById("signup-password").value = "";
        addAssistantMessage(`👋 Welcome to ChronosPA, **${name}**! Your account is ready.`);
      })
      .catch(err => {
        errorEl.textContent = friendlyAuthError(err.code);
        errorEl.classList.remove("hidden");
      });
  });

  // Auth state change handler — the core of the user experience
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

      // Start Firestore real-time sync
      syncTasksFromFirestore(user.uid);

      // Register FCM push token for this device
      initFcmMessaging(user.uid);

      addAssistantMessage(`🔒 Synced! Welcome back, **${displayName}**.`);
    } else {
      currentUser = null;
      AppState.tasks = [];

      // Reset UI
      nameLabel.textContent = "Sign In";
      dropName.textContent = "Guest User";
      dropEmail.textContent = "Please sign in to sync";

      // Show sign in, hide sign out
      if (signInBtn) signInBtn.classList.remove("hidden");
      if (signOutBtn) signOutBtn.classList.add("hidden");

      // Unsubscribe from Firestore
      if (userTasksUnsubscribe) {
        userTasksUnsubscribe();
        userTasksUnsubscribe = null;
      }

      // Show login overlay
      authOverlay.classList.remove("hidden");

      // Render empty state
      renderTimeline();
      renderCalendar();
      renderSelectedDayPreview();
      updateMetrics();
    }
  });
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

// --- FCM Push Notification Token Registration ---
async function initFcmMessaging(uid) {
  if (!fcmMessaging || !db) return;
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
      const title = payload.notification?.title || "ChronosPA";
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
    btn.className = "status-btn permission-granted";
    btnText.textContent = "Notifications Active";
    AppState.preferences.notificationPermission = "granted";
    saveState();
  } else if (Notification.permission === "denied") {
    btn.className = "status-btn permission-denied";
    btnText.textContent = "Blocked";
  } else {
    if (!silent) {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          btn.className = "status-btn permission-granted";
          btnText.textContent = "Notifications Active";
          playNotificationChime();
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
    if (task.date === todayStr && task.status === "pending" && !task.notified) {
      if (task.time <= currentTimeStr) {
        task.notified = true;
        stateUpdated = true;
        triggerReminder(task);
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
function triggerReminder(task) {
  playNotificationChime();

  if (Notification.permission === "granted") {
    try {
      new Notification(`Chronos PA: Time for Task`, {
        body: task.title,
        icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="%2300f3ff"><circle cx="50" cy="50" r="40" stroke="black" stroke-width="4"/></svg>'
      });
    } catch (e) {
      console.warn("Failed to pop desktop notification:", e);
    }
  }

  addAssistantMessage(`⏰ ALERT: Time to do: "**${task.title}**". Mark completed or postpone it.`, "alert-msg");
  showInAppAlertModal(task);
}

function showInAppAlertModal(task) {
  AppState.activeAlertTask = task;

  document.getElementById("alert-task-title").textContent = task.title;
  const [h, m] = task.time.split(":");
  const ampm = h >= 12 ? "PM" : "AM";
  const displayTime = `${h % 12 || 12}:${m} ${ampm}`;
  document.getElementById("alert-task-time").textContent = displayTime;

  const priorityBadge = document.getElementById("alert-task-priority");
  priorityBadge.className = `alert-priority-badge prio-${task.priority}`;
  priorityBadge.textContent = PriorityLabel[task.priority];

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
  const container = document.getElementById("task-timeline");
  const todayStr = getLocalDateString(new Date());
  const todayTasks = AppState.tasks.filter(t => t.date === todayStr);

  if (todayTasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="12" cy="12" r="10"></circle>
          <path d="M12 8v4l3 3"></path>
        </svg>
        <h4>Your Schedule is Clear</h4>
        <p>Type in the assistant panel or click '+' to schedule your first reminder.</p>
      </div>
    `;
    return;
  }

  todayTasks.sort((a, b) => a.time.localeCompare(b.time));

  const now = new Date();
  const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

  container.innerHTML = "";

  todayTasks.forEach(task => {
    let statusClass = "pending";
    if (task.status === "completed") {
      statusClass = "completed";
    } else if (task.time < currentTimeStr) {
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
            <h4>${task.title}</h4>
            <div class="task-meta-row">
              <span class="task-time-pill">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                ${displayTime}
              </span>
              <span class="priority-badge prio-${task.priority}-badge">${task.priority}</span>
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
  });
}

// --- Toggle Tasks completed status ---
function toggleTaskComplete(taskId) {
  const task = AppState.tasks.find(t => t.id === taskId);
  if (!task) return;

  const nextStatus = (task.status === "completed") ? "pending" : "completed";
  let nextNotified = task.notified;

  if (nextStatus === "pending") {
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

  filtered.forEach(task => {
    const item = document.createElement("div");
    item.className = "preview-item";
    const [h, m] = task.time.split(":");
    const ampm = h >= 12 ? "PM" : "AM";
    const displayTime = `${h % 12 || 12}:${m} ${ampm}`;

    item.innerHTML = `
      <div class="preview-item-left">
        <span class="preview-item-time">${displayTime}</span>
        <span class="preview-item-title ${task.status === 'completed' ? 'completed' : ''}">${task.title}</span>
      </div>
      <span class="priority-badge prio-${task.priority}-badge">${task.priority}</span>
    `;
    container.appendChild(item);
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
  document.getElementById("task-date").value = getLocalDateString(now);

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
  const repeat = document.getElementById("task-repeat").value;

  if (title && date && time) {
    const newTask = {
      id: "task-" + Date.now(),
      title, date, time, priority, repeat,
      status: "pending",
      notified: false,
      dueTimestamp: getTaskTimestamp(date, time)  // UTC epoch ms — used by Cloud Function for push notifications
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
function addAssistantMessage(text, className = "") {
  const log = document.getElementById("pa-chat-log");
  const msg = document.createElement("div");
  msg.className = `chat-message assistant-message ${className}`;
  msg.innerHTML = `
    <div class="message-content">${formatMarkdown(text)}</div>
    <div class="message-meta">Just now</div>
  `;
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
}

function addUserMessage(text) {
  const log = document.getElementById("pa-chat-log");
  const msg = document.createElement("div");
  msg.className = "chat-message user-message";
  msg.innerHTML = `
    <div class="message-content">${text}</div>
    <div class="message-meta">Just now</div>
  `;
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
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

function parseCommand(cmd) {
  const todayStr = getLocalDateString(new Date());
  let taskTitle = "";
  let timeStr = "";
  let isRelative = false;
  let delayMinutes = 0;
  let text = cmd.trim();

  // 1. Check for Relative Time
  const relativeRegex = /\b(?:in|after)\s+(\d+)\s*(min|mins|minute|minutes|hour|hours|hr|hrs)\b/i;
  const relativeMatch = text.match(relativeRegex);

  if (relativeMatch) {
    isRelative = true;
    const quantity = parseInt(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    let multiplier = 1;
    if (unit.startsWith("hour") || unit.startsWith("hr")) multiplier = 60;
    delayMinutes = quantity * multiplier;
    const targetTime = new Date(Date.now() + delayMinutes * 60 * 1000);
    timeStr = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
    text = text.replace(relativeRegex, "").trim();
  } else {
    // 2. Check for Absolute Time
    const absoluteRegex = /\b(?:at|for|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b$/i;
    const absoluteMatch = text.match(absoluteRegex);

    if (absoluteMatch) {
      let hour = parseInt(absoluteMatch[1]);
      const minute = absoluteMatch[2] || "00";
      const ampm = absoluteMatch[3] ? absoluteMatch[3].toLowerCase() : null;
      if (ampm === "pm" && hour < 12) hour += 12;
      if (ampm === "am" && hour === 12) hour = 0;
      timeStr = `${String(hour).padStart(2, '0')}:${minute}`;
      text = text.replace(absoluteRegex, "").trim();
    }
  }

  // Default to 1 hour from now if no time parsed
  if (!timeStr) {
    const targetTime = new Date(Date.now() + 60 * 60 * 1000);
    timeStr = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
    isRelative = true;
    delayMinutes = 60;
  }

  // Clean title
  const prefixes = [
    /^(?:remind me to|remind me|remind|add task|add|todo|schedule|alert)\s+/i,
    /^(?:to|for|at|in)\s+/i
  ];
  let cleaned = text;
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
  taskTitle = cleaned || "Reminder";

  const newTask = {
    id: "task-" + Date.now(),
    title: taskTitle,
    date: todayStr,
    time: timeStr,
    priority: "medium",
    status: "pending",
    notified: false,
    dueTimestamp: getTaskTimestamp(todayStr, timeStr)  // UTC epoch ms for Cloud Function
  };

  if (db && currentUser) {
    firestoreSaveTask(newTask)
      .catch(err => console.error("Command add task failed:", err));
  } else {
    AppState.tasks.push(newTask);
    saveState();
    refreshAllViews();
  }

  if (isRelative) {
    addAssistantMessage(`✍️ Reminder set: "**${taskTitle}**" in ${delayMinutes} minutes (at ${timeStr}).`);
  } else {
    addAssistantMessage(`📅 Scheduled: "**${taskTitle}**" today at ${timeStr}.`);
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
  document.getElementById("add-task-modal-btn").addEventListener("click", openAddTaskModal);
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
