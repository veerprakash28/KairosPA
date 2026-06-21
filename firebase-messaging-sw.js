// ==========================================================================
// ChronosPA - Firebase Cloud Messaging Dynamic Service Worker
// ==========================================================================

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

let messaging = null;

// Listen for the configuration message from the main thread
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'INIT_FIREBASE') {
    const config = event.data.config;
    try {
      // Initialize if not already initialized
      if (firebase.apps.length === 0) {
        firebase.initializeApp(config);
        messaging = firebase.messaging();

        // Background notifications listener
        messaging.onBackgroundMessage((payload) => {
          console.log('[firebase-messaging-sw.js] Received background message ', payload);
          const title = payload.notification?.title || "ChronosPA Alarm";
          const options = {
            body: payload.notification?.body || "Time to complete your scheduled task!",
            icon: 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="%2300f3ff"><circle cx="50" cy="50" r="40" stroke="black" stroke-width="4"/></svg>',
            tag: 'chronos-task-alert',
            renotify: true
          };

          self.registration.showNotification(title, options);
        });
        console.log('[firebase-messaging-sw.js] Firebase messaging initialized successfully in Service Worker.');
      }
    } catch (err) {
      console.error("[firebase-messaging-sw.js] Dynamic Firebase Init failed:", err);
    }
  }
});
