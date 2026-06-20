/* ==========================================================================
   ChronosPA Javascript - Application Logic, Notifications, and Assistant Engine
   ========================================================================== */

// --- Global App State ---
let AppState = {
  tasks: [],
  preferences: {
    username: "Veerp",
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
document.addEventListener("DOMContentLoaded", () => {
  loadState();
  initClock();
  initCalendar();
  initEventListeners();
  requestNotificationPermission(true); // check status silently
  checkOverduePreviousDays();
  renderTimeline();
  renderCalendar();
  renderSelectedDayPreview();
  updateMetrics();
});

// --- LocalStorage Persistence ---
function saveState() {
  localStorage.setItem("ChronosPA_State", JSON.stringify(AppState));
}

function loadState() {
  const saved = localStorage.getItem("ChronosPA_State");
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      // Automatically filter out old dummy demo tasks if they exist in localStorage
      AppState.tasks = (parsed.tasks || []).filter(t => !t.id.startsWith("demo-"));
      AppState.preferences = parsed.preferences || AppState.preferences;
    } catch (e) {
      console.error("Error loading localStorage state:", e);
    }
  } else {
    // Start clean with no dummy tasks
    AppState.tasks = [];
    saveState();
  }
}

// --- Live Clock & Time Management ---
function initClock() {
  const clockTime = document.getElementById("clock-time");
  const clockDate = document.getElementById("clock-date");
  const greetingText = document.getElementById("greeting-text");

  function tick() {
    const now = new Date();
    
    // Time format: HH:MM:SS
    clockTime.textContent = now.toLocaleTimeString([], { hour12: false });
    
    // Date format: Sunday, June 21, 2026
    clockDate.textContent = now.toLocaleDateString([], {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });

    // Dynamic greeting based on time of day
    const hour = now.getHours();
    let greeting = "Good Night";
    if (hour >= 5 && hour < 12) greeting = "Good Morning";
    else if (hour >= 12 && hour < 17) greeting = "Good Afternoon";
    else if (hour >= 17 && hour < 22) greeting = "Good Evening";
    
    greetingText.textContent = `${greeting}, ${AppState.preferences.username}`;

    // Tick scheduler
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
    
    // Ambient notification chords: E5 -> A5 -> C#6 (Gorgeous space vibe)
    const frequencies = [659.25, 880.00, 1109.73];
    
    frequencies.forEach((freq, index) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      
      // Delay play times to form a rising arpeggio chime
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
    console.warn("Audio Context block by browser or failed to init:", err);
  }
}

// --- Native Browser Notification Handler ---
function requestNotificationPermission(silent = false) {
  const btn = document.getElementById("notification-toggle-btn");
  const btnText = document.getElementById("notification-btn-text");

  if (!("Notification" in window)) {
    btnText.textContent = "Notifications Unsupported";
    return;
  }

  if (Notification.permission === "granted") {
    btn.className = "status-btn permission-granted";
    btnText.textContent = "Desktop Notifications Active";
    AppState.preferences.notificationPermission = "granted";
    saveState();
  } else if (Notification.permission === "denied") {
    btn.className = "status-btn permission-denied";
    btnText.textContent = "Notifications Blocked";
  } else {
    // If not granted or denied, we ask
    if (!silent) {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          btn.className = "status-btn permission-granted";
          btnText.textContent = "Desktop Notifications Active";
          playNotificationChime();
        } else {
          btn.className = "status-btn permission-denied";
          btnText.textContent = "Notifications Blocked";
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
  const nowHoursStr = String(now.getHours()).padStart(2, '0');
  const nowMinsStr = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${nowHoursStr}:${nowMinsStr}`;

  let stateUpdated = false;

  AppState.tasks.forEach(task => {
    // Trigger condition: today's date, time equals or is past current time, pending, and not yet notified in this session
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

  // 1. Native Desktop notification
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

  // 2. Chat Log notification
  addAssistantMessage(`⏰ ALERT: Time to do: "${task.title}". Status is active. Please mark completed or postpone it.`, "alert-msg");

  // 3. In-App Glassmorphic Alert Modal Popup
  showInAppAlertModal(task);
}

// --- Show Alert Modal Popup ---
function showInAppAlertModal(task) {
  AppState.activeAlertTask = task;
  
  document.getElementById("alert-task-title").textContent = task.title;
  
  // Format time (from 24h to 12h)
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

// --- Check Overdue from previous days (Carry Forward Engine) ---
function checkOverduePreviousDays() {
  const todayStr = getLocalDateString(new Date());
  
  // Count incomplete tasks from yesterday or earlier
  const overdueTasks = AppState.tasks.filter(t => t.date < todayStr && t.status !== "completed" && t.status !== "carried");
  const banner = document.getElementById("carry-forward-banner");
  
  if (overdueTasks.length > 0) {
    document.getElementById("carry-forward-message").textContent = `You have ${overdueTasks.length} pending task${overdueTasks.length > 1 ? 's' : ''} from yesterday!`;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// --- Carry Forward Action Handlers ---
function carryAllForwardToToday() {
  const todayStr = getLocalDateString(new Date());
  let count = 0;
  
  AppState.tasks.forEach(t => {
    if (t.date < todayStr && t.status !== "completed" && t.status !== "carried") {
      t.carriedFrom = t.date;
      t.date = todayStr;
      t.notified = false; // Reset notification trigger
      count++;
    }
  });

  if (count > 0) {
    saveState();
    checkOverduePreviousDays();
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    addAssistantMessage(`✅ I have successfully carried forward ${count} task${count > 1 ? 's' : ''} to today's schedule!`);
  }
}

function carrySingleForward(taskId) {
  const todayStr = getLocalDateString(new Date());
  const task = AppState.tasks.find(t => t.id === taskId);
  
  if (task) {
    task.carriedFrom = task.date;
    task.date = todayStr;
    task.notified = false; // Reset alert trigger
    
    saveState();
    checkOverduePreviousDays();
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    addAssistantMessage(`🔄 Postponed: "${task.title}" carried forward to today.`);
  }
}

// --- UI Board & Timeline Renderers ---
function renderTimeline() {
  const container = document.getElementById("task-timeline");
  const todayStr = getLocalDateString(new Date());
  
  // Get all tasks for today
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

  // Sort tasks chronologically
  todayTasks.sort((a, b) => a.time.localeCompare(b.time));

  const now = new Date();
  const nowHoursStr = String(now.getHours()).padStart(2, '0');
  const nowMinsStr = String(now.getMinutes()).padStart(2, '0');
  const currentTimeStr = `${nowHoursStr}:${nowMinsStr}`;

  container.innerHTML = "";

  todayTasks.forEach(task => {
    // Determine card status: completed, overdue, active, pending
    let statusClass = "pending";
    if (task.status === "completed") {
      statusClass = "completed";
    } else if (task.time < currentTimeStr) {
      statusClass = "overdue";
    } else if (task.notified) {
      statusClass = "active";
    }

    // Format 12-hour clock
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
          ${task.status !== 'completed' && task.date < todayStr ? `
            <button class="task-action-btn btn-carry-forward" onclick="carrySingleForward('${task.id}')" title="Carry Forward to Today">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
            </button>
          ` : ''}
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
  if (task) {
    task.status = (task.status === "completed") ? "pending" : "completed";
    
    // If turning back to pending, we reset notified if task is in the future
    if (task.status === "pending") {
      const now = new Date();
      const todayStr = getLocalDateString(now);
      const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      if (task.date > todayStr || (task.date === todayStr && task.time > currentTimeStr)) {
        task.notified = false;
      }
    }

    saveState();
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    checkOverduePreviousDays();

    if (task.status === "completed") {
      addAssistantMessage(`🎉 Awesome job completing the task: "${task.title}"! Keep up the momentum.`);
    }
  }
}

// --- Delete task ---
function deleteTask(taskId) {
  const index = AppState.tasks.findIndex(t => t.id === taskId);
  if (index !== -1) {
    const title = AppState.tasks[index].title;
    AppState.tasks.splice(index, 1);
    
    saveState();
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    checkOverduePreviousDays();
    addAssistantMessage(`🗑️ Deleted: "${title}" has been removed from schedules.`);
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
  const startDayOfWeek = firstDay.getDay(); // 0 is Sunday, 6 is Saturday
  const daysInMonth = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth, 0).getDate();

  const today = new Date();
  const todayStr = getLocalDateString(today);
  const selectedStr = getLocalDateString(AppState.selectedCalendarDate);

  // 1. Fill previous month's overlapping days
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.textContent = daysInPrevMonth - i;
    calGrid.appendChild(cell);
  }

  // 2. Fill current month's active days
  for (let day = 1; day <= daysInMonth; day++) {
    const currentCellDate = new Date(AppState.currentCalendarYear, AppState.currentCalendarMonth, day);
    const dateStr = getLocalDateString(currentCellDate);

    const cell = document.createElement("div");
    cell.className = "calendar-day-cell";
    cell.textContent = day;

    // Highlight conditions
    if (dateStr === todayStr) cell.classList.add("today");
    if (dateStr === selectedStr) cell.classList.add("selected");

    // Add indicator dots based on scheduled tasks
    const dateTasks = AppState.tasks.filter(t => t.date === dateStr);
    if (dateTasks.length > 0) {
      const dotContainer = document.createElement("div");
      dotContainer.className = "day-dots-container";
      
      // Limit to 3 visual dots max
      const maxDots = Math.min(dateTasks.length, 3);
      for (let k = 0; k < maxDots; k++) {
        const dot = document.createElement("span");
        dot.className = "day-dot";
        if (dateTasks[k].status === "completed") {
          dot.classList.add("dot-completed");
        } else if (dateTasks[k].priority === "high") {
          dot.classList.add("dot-high");
        }
        dotContainer.appendChild(dot);
      }
      cell.appendChild(dotContainer);
    }

    // Click handler to select calendar date
    cell.addEventListener("click", () => {
      AppState.selectedCalendarDate = currentCellDate;
      renderCalendar();
      renderSelectedDayPreview();
    });

    calGrid.appendChild(cell);
  }

  // 3. Fill trailing space with next month's days
  const totalCellsFilled = startDayOfWeek + daysInMonth;
  const trailingCellsNeeded = 42 - totalCellsFilled; // standard 6-row grid
  for (let day = 1; day <= trailingCellsNeeded; day++) {
    const cell = document.createElement("div");
    cell.className = "calendar-day-cell other-month";
    cell.textContent = day;
    calGrid.appendChild(cell);
  }
}

// Navigate Month Calendar
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
  
  // Format pretty title (e.g. "Tasks for Sunday, Jun 21, 2026")
  const prettyDate = AppState.selectedCalendarDate.toLocaleDateString([], {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  title.textContent = `Tasks for ${prettyDate}`;

  // Filter tasks for this calendar date
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
    
    // Format 12-hour clock
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
  
  // Set default values (today's date, current time + 5 mins)
  const now = new Date();
  document.getElementById("task-date").value = getLocalDateString(now);
  
  // Round to nearest time increments
  const fut = new Date(now.getTime() + 5 * 60 * 1000);
  const hours = String(fut.getHours()).padStart(2, '0');
  const minutes = String(fut.getMinutes()).padStart(2, '0');
  document.getElementById("task-time").value = `${hours}:${minutes}`;

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
      title: title,
      date: date,
      time: time,
      priority: priority,
      repeat: repeat,
      status: "pending",
      notified: false
    };

    AppState.tasks.push(newTask);
    saveState();
    closeAddTaskModal();
    
    // Refresh views
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    checkOverduePreviousDays();

    addAssistantMessage(`📝 I have scheduled your task: "${title}" on ${date} at ${time}.`);
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
  
  // 1. Match: "remind me to [task] in [X] mins/minutes/hours"
  const relativeMatch = cmd.match(/(?:remind me to|add task|todo)\s+(.+?)\s+(?:in|after)\s+(\d+)\s*(min|mins|minute|minutes|hour|hours)/i);
  
  if (relativeMatch) {
    const taskTitle = relativeMatch[1].trim();
    const quantity = parseInt(relativeMatch[2]);
    const unit = relativeMatch[3].toLowerCase();
    
    let multiplier = 60 * 1000; // default mins
    if (unit.startsWith("hour")) {
      multiplier = 60 * 60 * 1000;
    }
    
    const targetTime = new Date(Date.now() + quantity * multiplier);
    const targetTimeStr = `${String(targetTime.getHours()).padStart(2, '0')}:${String(targetTime.getMinutes()).padStart(2, '0')}`;
    
    const newTask = {
      id: "task-" + Date.now(),
      title: taskTitle,
      date: todayStr,
      time: targetTimeStr,
      priority: "medium",
      status: "pending",
      notified: false
    };

    AppState.tasks.push(newTask);
    saveState();
    
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    
    addAssistantMessage(`✍️ Understood! I have set a reminder for **"${taskTitle}"** today in ${quantity} ${unit} (at ${targetTimeStr}).`);
    return;
  }

  // 2. Match: "remind me to [task] at [HH:MM] (AM/PM)" or "add task [task] for [HH](:MM) (AM/PM)"
  const absoluteMatch = cmd.match(/(?:remind me to|add task|todo|add)\s+(.+?)\s+(?:at|for|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  
  if (absoluteMatch) {
    const taskTitle = absoluteMatch[1].trim();
    let hour = parseInt(absoluteMatch[2]);
    const minute = absoluteMatch[3] || "00";
    const ampm = absoluteMatch[4] ? absoluteMatch[4].toLowerCase() : null;

    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;

    const formattedHour = String(hour).padStart(2, '0');
    const timeStr = `${formattedHour}:${minute}`;

    const newTask = {
      id: "task-" + Date.now(),
      title: taskTitle,
      date: todayStr,
      time: timeStr,
      priority: "medium",
      status: "pending",
      notified: false
    };

    AppState.tasks.push(newTask);
    saveState();

    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();

    addAssistantMessage(`📅 Scheduled: **"${taskTitle}"** today at ${timeStr}. I will chime when it's time.`);
    return;
  }

  // 3. Match: "carry forward" or "reschedule yesterday"
  if (cmd.toLowerCase().includes("carry forward") || cmd.toLowerCase().includes("reschedule")) {
    const todayStr = getLocalDateString(new Date());
    const overdueTasks = AppState.tasks.filter(t => t.date < todayStr && t.status !== "completed" && t.status !== "carried");
    
    if (overdueTasks.length > 0) {
      carryAllForwardToToday();
    } else {
      addAssistantMessage("🔍 I checked, and you have no overdue tasks to carry forward from previous days.");
    }
    return;
  }

  // 4. Match general add request: "add [task]" or "todo [task]"
  const simpleMatch = cmd.match(/^(?:add|todo)\s+(.+)/i);
  if (simpleMatch) {
    const taskTitle = simpleMatch[1].trim();
    // Default to today in 1 hour
    const fut = new Date(Date.now() + 60 * 60 * 1000);
    const timeStr = `${String(fut.getHours()).padStart(2, '0')}:${String(fut.getMinutes()).padStart(2, '0')}`;
    
    const newTask = {
      id: "task-" + Date.now(),
      title: taskTitle,
      date: todayStr,
      time: timeStr,
      priority: "medium",
      status: "pending",
      notified: false
    };

    AppState.tasks.push(newTask);
    saveState();

    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();

    addAssistantMessage(`📝 Added task: **"${taskTitle}"** at ${timeStr} today.`);
    return;
  }

  // 5. Fallback conversational interface helper
  addAssistantMessage(`🤖 Sorry, I didn't quite capture that command structure. Try these examples:
    <ul>
      <li><code>remind me to exercise in 15 mins</code></li>
      <li><code>add task review code at 14:00</code></li>
      <li><code>remind me to check email at 5:30 pm</code></li>
      <li><code>carry forward yesterday's tasks</code></li>
    </ul>
    You can also manually click the '+' icon next to 'Today's Focus' to fill details in our forms!
  `);
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

  // Alert overlay actions
  document.getElementById("alert-complete-btn").addEventListener("click", () => {
    if (AppState.activeAlertTask) {
      toggleTaskComplete(AppState.activeAlertTask.id);
    }
    hideInAppAlertModal();
  });

  document.getElementById("alert-postpone-btn").addEventListener("click", () => {
    if (AppState.activeAlertTask) {
      // Add 15 minutes to task time
      const task = AppState.activeAlertTask;
      const [h, m] = task.time.split(":");
      const d = new Date();
      d.setHours(parseInt(h));
      d.setMinutes(parseInt(m) + 15);
      
      task.time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      task.notified = false; // Reset trigger
      
      saveState();
      renderTimeline();
      renderCalendar();
      renderSelectedDayPreview();
      updateMetrics();
      addAssistantMessage(`🕒 Postponed: **"${task.title}"** shifted forward by 15 mins.`);
    }
    hideInAppAlertModal();
  });

  document.getElementById("alert-carry-btn").addEventListener("click", () => {
    if (AppState.activeAlertTask) {
      // Move to tomorrow's date
      const task = AppState.activeAlertTask;
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      
      task.carriedFrom = task.date;
      task.date = getLocalDateString(tomorrow);
      task.notified = false; // Reset notification trigger
      
      saveState();
      checkOverduePreviousDays();
      renderTimeline();
      renderCalendar();
      renderSelectedDayPreview();
      updateMetrics();
      addAssistantMessage(`🔄 Rescheduled: **"${task.title}"** carried forward to tomorrow.`);
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
    const oldDate = task.date;
    task.date = date;
    task.time = time;
    
    // Reset notification trigger if scheduled for future
    const now = new Date();
    const todayStr = getLocalDateString(now);
    const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    if (task.date > todayStr || (task.date === todayStr && task.time > currentTimeStr)) {
      task.notified = false;
    }

    saveState();
    closeRescheduleModal();
    
    renderTimeline();
    renderCalendar();
    renderSelectedDayPreview();
    updateMetrics();
    checkOverduePreviousDays();
    
    addAssistantMessage(`🔄 Rescheduled: **"${task.title}"** has been moved to ${date} at ${time}.`);
  }
}

// Bind reschedule handlers
function initRescheduleEvents() {
  document.getElementById("reschedule-modal-close").addEventListener("click", closeRescheduleModal);
  document.getElementById("reschedule-modal-cancel").addEventListener("click", closeRescheduleModal);
  document.getElementById("reschedule-modal-form").addEventListener("submit", handleRescheduleSubmit);
}

// Wrap initialization to include new events
const originalInitEventListeners = initEventListeners;
initEventListeners = function() {
  originalInitEventListeners();
  initRescheduleEvents();
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
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}
