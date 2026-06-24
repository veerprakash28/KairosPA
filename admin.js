/* ==========================================================================
   KairosPA Admin Panel Javascript - Administrative Console & Logs Audits
   ========================================================================== */

let firebaseConfig = null;
let db = null;
let auth = null;
let firebaseActive = false;

let usersList = [];
let selectedUserId = null;
let tasksListenerUnsubscribe = null;
let logsListenerUnsubscribe = null;

// Pagination & search state for activity logs
let currentUserLogs = [];
let filteredUserLogs = [];
let currentLogsPage = 1;
const logsPerPage = 10;

// Pagination & search state for user tasks
let currentUserTasks = [];
let filteredUserTasks = [];
let currentTasksPage = 1;
const tasksPerPage = 5;

// Load Firebase configuration from config.json
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
    console.error("Failed to load config.json:", e);
  }
  return false;
}

function initFirebase() {
  if (!firebaseConfig || !firebaseConfig.apiKey) return false;
  try {
    firebase.initializeApp(firebaseConfig);
    db = firebase.firestore();
    auth = firebase.auth();
    return true;
  } catch (err) {
    console.error("Firebase init failed:", err);
    return false;
  }
}

// Initial Load
document.addEventListener("DOMContentLoaded", async () => {
  const configLoaded = await loadFirebaseConfig();
  firebaseActive = configLoaded && initFirebase();

  if (!firebaseActive) {
    alert("Firebase configuration is missing or invalid. Admin panel unavailable.");
    return;
  }

  // Handle Admin Sign In Form Submission
  document.getElementById("admin-login-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const email = document.getElementById("admin-email").value.trim();
    const password = document.getElementById("admin-password").value;
    const errorEl = document.getElementById("admin-login-error");
    errorEl.classList.add("hidden");

    // Secure local verification via config.json
    const adminEmail = firebaseConfig && firebaseConfig.adminEmail;
    if (!adminEmail) {
      errorEl.textContent = "Access Denied: Administration email configuration is missing.";
      errorEl.classList.remove("hidden");
      return;
    }
    if (email !== adminEmail) {
      errorEl.textContent = "Access Denied: Email is not authorized as Administrator.";
      errorEl.classList.remove("hidden");
      return;
    }

    auth.signInWithEmailAndPassword(email, password)
      .catch(err => {
        errorEl.textContent = err.message;
        errorEl.classList.remove("hidden");
      });
  });

  // Handle Sign Out
  document.getElementById("admin-signout-btn").addEventListener("click", () => {
    auth.signOut();
  });

  // Monitor Auth State
  auth.onAuthStateChanged(user => {
    const authOverlay = document.getElementById("admin-auth-overlay");
    const dashboard = document.getElementById("admin-dashboard");
    const adminEmail = firebaseConfig && firebaseConfig.adminEmail;

    if (user && adminEmail && user.email === adminEmail) {
      authOverlay.classList.add("hidden");
      dashboard.classList.remove("hidden");
      
      // Load Users Directory
      loadUsersDirectory();
    } else {
      if (user) {
        // If logged in as someone else, sign them out immediately
        auth.signOut();
      }
      authOverlay.classList.remove("hidden");
      dashboard.classList.add("hidden");
      resetAdminUI();
    }
  });

  // Handle Search Filter Input
  document.getElementById("admin-user-search").addEventListener("input", (e) => {
    const filter = e.target.value.toLowerCase().trim();
    renderUsersList(filter);
  });

  // Handle Log Search Input
  const logSearchInput = document.getElementById("admin-log-search");
  if (logSearchInput) {
    logSearchInput.addEventListener("input", () => {
      currentLogsPage = 1;
      filterAndRenderLogs();
    });
  }

  // Handle Task Search Input
  const taskSearchInput = document.getElementById("admin-task-search");
  if (taskSearchInput) {
    taskSearchInput.addEventListener("input", () => {
      currentTasksPage = 1;
      filterAndRenderTasks();
    });
  }
});

function resetAdminUI() {
  selectedUserId = null;
  currentUserLogs = [];
  filteredUserLogs = [];
  currentLogsPage = 1;

  currentUserTasks = [];
  filteredUserTasks = [];
  currentTasksPage = 1;

  if (tasksListenerUnsubscribe) {
    tasksListenerUnsubscribe();
    tasksListenerUnsubscribe = null;
  }
  if (logsListenerUnsubscribe) {
    logsListenerUnsubscribe();
    logsListenerUnsubscribe = null;
  }

  // Clear search fields
  const logSearchInput = document.getElementById("admin-log-search");
  if (logSearchInput) logSearchInput.value = "";

  const taskSearchInput = document.getElementById("admin-task-search");
  if (taskSearchInput) taskSearchInput.value = "";

  document.getElementById("user-profile-summary-card").classList.add("hidden");
  document.getElementById("user-details-container").classList.add("hidden");
  document.getElementById("selected-user-header").textContent = "Select a User";
  document.getElementById("selected-user-sub-header").textContent = "Select a user profile from the sidebar to inspect their workspace audits";
}

// Fetch all registered users from Firestore
function loadUsersDirectory() {
  db.collection("users").orderBy("displayName", "asc").onSnapshot(snapshot => {
    usersList = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      if (!data.uid) {
        data.uid = doc.id;
      }
      usersList.push(data);
    });
    renderUsersList();
  }, err => {
    console.error("Error loading users directory:", err);
  });
}

// Render the sidebar users list
function renderUsersList(filter = "") {
  const container = document.getElementById("admin-users-list-container");
  if (!container) return;

  const filtered = usersList.filter(user => {
    const name = (user.displayName || "").toLowerCase();
    const email = (user.email || "").toLowerCase();
    return name.includes(filter) || email.includes(filter);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 20px;"><p>No matching users found.</p></div>`;
    return;
  }

  container.innerHTML = "";
  filtered.forEach(user => {
    const div = document.createElement("div");
    div.className = `admin-user-item ${selectedUserId === user.uid ? "active" : ""}`;
    div.innerHTML = `
      <div class="user-avatar-small">
        ${user.photoURL ? `<img src="${user.photoURL}" alt="avatar" />` : `<span class="avatar-placeholder">${(user.displayName || "U")[0].toUpperCase()}</span>`}
      </div>
      <div class="user-item-info">
        <strong>${user.displayName || "Anonymous"}</strong>
        <span>${user.email || "No Email"}</span>
      </div>
    `;
    div.addEventListener("click", () => selectUser(user));
    container.appendChild(div);
  });
}

// Inspect a specific user
function selectUser(user) {
  selectedUserId = user.uid;
  renderUsersList(); // refresh active highlight

  // Display user details in top banner
  document.getElementById("summary-name").textContent = user.displayName || "Anonymous";
  document.getElementById("summary-email").textContent = user.email || "No Email";
  document.getElementById("summary-uid").textContent = user.uid;
  
  let lastActiveStr = "N/A";
  if (user.lastActive) {
    try {
      if (typeof user.lastActive.toDate === "function") {
        lastActiveStr = user.lastActive.toDate().toLocaleString();
      } else {
        lastActiveStr = new Date(user.lastActive).toLocaleString();
      }
    } catch (e) {
      console.error("Error formatting lastActive time:", e);
    }
  }
  document.getElementById("summary-active").textContent = lastActiveStr;

  // Render large avatar in banner
  const avatarContainer = document.getElementById("summary-avatar-container");
  if (avatarContainer) {
    const initials = (user.displayName || "U")[0].toUpperCase();
    avatarContainer.innerHTML = user.photoURL 
      ? `<img src="${user.photoURL}" alt="avatar" />` 
      : `<span class="avatar-placeholder">${initials}</span>`;
  }

  document.getElementById("selected-user-header").textContent = user.displayName || "Anonymous";
  document.getElementById("selected-user-sub-header").textContent = `Auditing tasks and activity logs for ${user.email}`;
  
  // Show layout components
  document.getElementById("user-profile-summary-card").classList.remove("hidden");
  document.getElementById("user-details-container").classList.remove("hidden");

  // Listen to tasks (including deleted)
  if (tasksListenerUnsubscribe) tasksListenerUnsubscribe();
  tasksListenerUnsubscribe = db.collection("users").doc(user.uid).collection("tasks")
    .onSnapshot(snapshot => {
      let tasks = [];
      snapshot.forEach(doc => {
        tasks.push({ id: doc.id, ...doc.data() });
      });
      
      // Sort tasks client-side: by date desc, then by time desc
      tasks.sort((a, b) => {
        const dateTimeA = a.date && a.time ? `${a.date}T${a.time}` : (a.date || "");
        const dateTimeB = b.date && b.time ? `${b.date}T${b.time}` : (b.date || "");
        if (dateTimeA < dateTimeB) return 1;
        if (dateTimeA > dateTimeB) return -1;
        return 0;
      });

      currentUserTasks = tasks;
      currentTasksPage = 1;
      filterAndRenderTasks();
    }, err => {
      console.error("Error loading user tasks:", err);
      const container = document.getElementById("admin-tasks-list-container");
      if (container) {
        container.innerHTML = `
          <div class="empty-state" style="padding: 20px; border: 1px dashed rgba(239, 68, 68, 0.4); border-radius: 8px;">
            <p style="color: #ef4444; margin-bottom: 4px; font-weight: 600;">⚠️ Access Denied / Error</p>
            <p style="font-size: 0.75rem; color: #94a3b8;">${err.message || 'Firestore security rules blocking access.'}</p>
          </div>
        `;
      }
    });

  // Listen to activity logs
  if (logsListenerUnsubscribe) logsListenerUnsubscribe();
  logsListenerUnsubscribe = db.collection("users").doc(user.uid).collection("activity_logs")
    .onSnapshot(snapshot => {
      let logs = [];
      snapshot.forEach(doc => {
        logs.push(doc.data());
      });
      
      // Sort client-side: handle firestore Timestamps, JS Date objects, strings, numbers safely
      logs.sort((a, b) => {
        const timeA = a.timestamp ? (typeof a.timestamp.toDate === "function" ? a.timestamp.toDate().getTime() : new Date(a.timestamp).getTime()) : 0;
        const timeB = b.timestamp ? (typeof b.timestamp.toDate === "function" ? b.timestamp.toDate().getTime() : new Date(b.timestamp).getTime()) : 0;
        return timeB - timeA;
      });

      currentUserLogs = logs;
      currentLogsPage = 1;
      filterAndRenderLogs();
    }, err => {
      console.error("Error loading user logs:", err);
      const container = document.getElementById("admin-logs-container");
      if (container) {
        container.innerHTML = `
          <div class="empty-state" style="padding: 20px; border: 1px dashed rgba(239, 68, 68, 0.4); border-radius: 8px;">
            <p style="color: #ef4444; margin-bottom: 4px; font-weight: 600;">⚠️ Access Denied / Error</p>
            <p style="font-size: 0.75rem; color: #94a3b8;">${err.message || 'Firestore security rules blocking access.'}</p>
          </div>
        `;
      }
    });
}

// Filter user tasks based on search query
function filterAndRenderTasks() {
  const searchInput = document.getElementById("admin-task-search");
  const filterText = searchInput ? searchInput.value.toLowerCase().trim() : "";

  filteredUserTasks = currentUserTasks.filter(task => {
    const titleText = (task.title || "").toLowerCase();
    const priorityText = (task.priority || "").toLowerCase();
    const statusText = (task.deleted ? "deleted" : task.status || "").toLowerCase();
    const dateText = (task.date || "").toLowerCase();
    const timeText = (task.time || "").toLowerCase();

    return titleText.includes(filterText) || 
           priorityText.includes(filterText) || 
           statusText.includes(filterText) || 
           dateText.includes(filterText) || 
           timeText.includes(filterText);
  });

  renderTasksPage();
}

// Render active page of tasks along with pagination controls (5 items per page)
function renderTasksPage() {
  const container = document.getElementById("admin-tasks-list-container");
  const paginationContainer = document.getElementById("admin-tasks-pagination-container");
  const countLabel = document.getElementById("tasks-count-label");
  if (!container) return;

  countLabel.textContent = `${filteredUserTasks.length} matching / ${currentUserTasks.length} Total`;

  if (filteredUserTasks.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 40px 20px;">
        <h4>No Tasks Found</h4>
        <p>No tasks match the filter criteria.</p>
      </div>
    `;
    if (paginationContainer) paginationContainer.innerHTML = "";
    return;
  }

  // Calculate pages
  const totalPages = Math.ceil(filteredUserTasks.length / tasksPerPage);
  if (currentTasksPage > totalPages) currentTasksPage = totalPages;
  if (currentTasksPage < 1) currentTasksPage = 1;

  const startIndex = (currentTasksPage - 1) * tasksPerPage;
  const endIndex = Math.min(startIndex + tasksPerPage, filteredUserTasks.length);
  const pageTasks = filteredUserTasks.slice(startIndex, endIndex);

  container.innerHTML = "";
  pageTasks.forEach(task => {
    const div = document.createElement("div");
    div.className = `admin-task-card ${task.deleted ? "deleted-task" : ""}`;
    
    const statusText = task.deleted ? "DELETED" : (task.status || "not-started");
    const priorityText = (task.priority || "medium").toUpperCase();

    div.innerHTML = `
      <div class="task-card-meta">
        <span class="prio-tag prio-${task.priority}">${priorityText}</span>
        <span class="status-tag status-${task.deleted ? 'deleted' : task.status}">${statusText}</span>
      </div>
      <h4>${task.title}</h4>
      <p class="task-card-time">📅 ${task.date} &nbsp; ⏰ ${task.time}</p>
      <div class="task-card-actions" style="margin-top: 12px; display: flex; gap: 8px;">
        ${task.deleted ? `
          <button class="glass-button-secondary restore-btn" onclick="restoreUserTask('${task.id}')">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M3 21v-5h5"/></svg>
            Restore Task
          </button>
        ` : `
          <button class="glass-button-secondary status-toggle-btn" onclick="toggleUserTaskStatus('${task.id}', '${task.status}')">
            ${task.status === "completed" ? `
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M18 6L6 18M6 6l12 12"/></svg>
              Mark Incomplete
            ` : `
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M20 6L9 17l-5-5"/></svg>
              Mark Completed
            `}
          </button>
          <button class="glass-button-danger delete-btn" onclick="deleteUserTask('${task.id}')">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="margin-right: 4px; display: inline-block; vertical-align: middle;"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>
            Delete
          </button>
        `}
      </div>
    `;
    container.appendChild(div);
  });

  // Render pagination buttons
  if (paginationContainer) {
    if (filteredUserTasks.length <= tasksPerPage) {
      paginationContainer.innerHTML = "";
    } else {
      paginationContainer.innerHTML = `
        <button id="tasks-prev-btn" ${currentTasksPage === 1 ? "disabled" : ""}>&larr; Prev</button>
        <span>Page ${currentTasksPage} of ${totalPages}</span>
        <button id="tasks-next-btn" ${currentTasksPage === totalPages ? "disabled" : ""}>Next &rarr;</button>
      `;

      document.getElementById("tasks-prev-btn").addEventListener("click", () => {
        currentTasksPage--;
        renderTasksPage();
      });

      document.getElementById("tasks-next-btn").addEventListener("click", () => {
        currentTasksPage++;
        renderTasksPage();
      });
    }
  }
}

// Restore a soft-deleted task
function restoreUserTask(taskId) {
  if (!selectedUserId || !db) return;
  
  db.collection("users").doc(selectedUserId).collection("tasks").doc(taskId).update({
    deleted: false,
    deletedAt: null
  })
  .then(() => {
    // Log the restore action under the user's activity logs so they know it was restored by admin
    return db.collection("users").doc(selectedUserId).collection("activity_logs").add({
      actionType: "admin_restore_task",
      details: { taskId: taskId },
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userAgent: "KairosPA Admin Panel"
    });
  })
  .then(() => {
    console.log(`Task ${taskId} restored successfully.`);
  })
  .catch(err => {
    console.error("Error restoring task:", err);
  });
}

// Soft delete a user task
function deleteUserTask(taskId) {
  if (!selectedUserId || !db) return;
  if (!confirm("Are you sure you want to soft-delete this user task?")) return;

  db.collection("users").doc(selectedUserId).collection("tasks").doc(taskId).update({
    deleted: true,
    deletedAt: firebase.firestore.FieldValue.serverTimestamp()
  })
  .then(() => {
    return db.collection("users").doc(selectedUserId).collection("activity_logs").add({
      actionType: "delete_task",
      details: { taskId: taskId },
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userAgent: "KairosPA Admin Panel"
    });
  })
  .then(() => {
    console.log(`Task ${taskId} soft-deleted successfully.`);
  })
  .catch(err => {
    console.error("Error soft-deleting task:", err);
  });
}

// Toggle a user task status between completed and not-started
function toggleUserTaskStatus(taskId, currentStatus) {
  if (!selectedUserId || !db) return;
  const newStatus = currentStatus === "completed" ? "not-started" : "completed";

  db.collection("users").doc(selectedUserId).collection("tasks").doc(taskId).update({
    status: newStatus
  })
  .then(() => {
    return db.collection("users").doc(selectedUserId).collection("activity_logs").add({
      actionType: newStatus === "completed" ? "complete_task" : "incomplete_task",
      details: { taskId: taskId },
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      userAgent: "KairosPA Admin Panel"
    });
  })
  .then(() => {
    console.log(`Task ${taskId} status set to ${newStatus}.`);
  })
  .catch(err => {
    console.error("Error toggling task status:", err);
  });
}

// Filter logs based on search query
function filterAndRenderLogs() {
  const searchInput = document.getElementById("admin-log-search");
  const filterText = searchInput ? searchInput.value.toLowerCase().trim() : "";

  filteredUserLogs = currentUserLogs.filter(log => {
    const actionText = formatActionType(log.actionType).toLowerCase();
    
    let detailText = "";
    if (log.details) {
      if (log.details.title) detailText = log.details.title.toLowerCase();
      else if (log.details.method) detailText = log.details.method.toLowerCase();
      else if (log.details.taskId) detailText = log.details.taskId.toLowerCase();
    }
    
    let timeStr = "";
    if (log.timestamp) {
      try {
        const date = typeof log.timestamp.toDate === "function" ? log.timestamp.toDate() : new Date(log.timestamp);
        timeStr = date.toLocaleString().toLowerCase();
      } catch (e) {}
    }

    return actionText.includes(filterText) || detailText.includes(filterText) || timeStr.includes(filterText);
  });

  renderLogsPage();
}

// Render active page of filtered logs along with pagination controls
function renderLogsPage() {
  const container = document.getElementById("admin-logs-container");
  const paginationContainer = document.getElementById("admin-logs-pagination-container");
  if (!container) return;

  if (filteredUserLogs.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: 20px;"><p>No activity logs found matching filter.</p></div>`;
    if (paginationContainer) paginationContainer.innerHTML = "";
    return;
  }

  // Calculate pagination boundaries
  const totalPages = Math.ceil(filteredUserLogs.length / logsPerPage);
  if (currentLogsPage > totalPages) currentLogsPage = totalPages;
  if (currentLogsPage < 1) currentLogsPage = 1;

  const startIndex = (currentLogsPage - 1) * logsPerPage;
  const endIndex = Math.min(startIndex + logsPerPage, filteredUserLogs.length);
  const pageLogs = filteredUserLogs.slice(startIndex, endIndex);

  // Render log items
  container.innerHTML = "";
  pageLogs.forEach(log => {
    const item = document.createElement("div");
    item.className = "log-item";
    
    let timeStr = "N/A";
    if (log.timestamp) {
      try {
        if (typeof log.timestamp.toDate === "function") {
          const d = log.timestamp.toDate();
          timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + 
                    " - " + d.toLocaleDateString();
        } else if (log.timestamp instanceof Date) {
          timeStr = log.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + 
                    " - " + log.timestamp.toLocaleDateString();
        } else if (typeof log.timestamp === "number" || typeof log.timestamp === "string") {
          const d = new Date(log.timestamp);
          timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + 
                    " - " + d.toLocaleDateString();
        }
      } catch (err) {
        console.error("Error parsing log timestamp:", err);
      }
    }

    let detailStr = "";
    if (log.details) {
      if (log.details.title) detailStr = `("${log.details.title}")`;
      else if (log.details.method) detailStr = `(via ${log.details.method})`;
    }

    item.innerHTML = `
      <div class="log-dot"></div>
      <div class="log-content">
        <span class="log-time">${timeStr}</span>
        <p class="log-text"><strong>${formatActionType(log.actionType)}</strong> ${detailStr}</p>
      </div>
    `;
    container.appendChild(item);
  });

  // Render pagination buttons
  if (paginationContainer) {
    if (filteredUserLogs.length <= logsPerPage) {
      paginationContainer.innerHTML = "";
    } else {
      paginationContainer.innerHTML = `
        <button id="logs-prev-btn" ${currentLogsPage === 1 ? "disabled" : ""}>&larr; Prev</button>
        <span>Page ${currentLogsPage} of ${totalPages}</span>
        <button id="logs-next-btn" ${currentLogsPage === totalPages ? "disabled" : ""}>Next &rarr;</button>
      `;

      document.getElementById("logs-prev-btn").addEventListener("click", () => {
        currentLogsPage--;
        renderLogsPage();
      });

      document.getElementById("logs-next-btn").addEventListener("click", () => {
        currentLogsPage++;
        renderLogsPage();
      });
    }
  }
}

function formatActionType(action) {
  const mapping = {
    "login": "User Signed In",
    "logout": "User Signed Out",
    "signup": "Account Registered",
    "session_restore": "Session Restored (Page Load)",
    "create_task": "Task Created",
    "complete_task": "Task Completed",
    "incomplete_task": "Task Unchecked",
    "delete_task": "Task Deleted (Soft)",
    "admin_restore_task": "Task Restored by Admin",
    "clear_chat": "Chat Logs Cleared",
    "carry_forward_all": "Tasks Rolled Over to Today"
  };
  return mapping[action] || action || "Unknown Action";
}
