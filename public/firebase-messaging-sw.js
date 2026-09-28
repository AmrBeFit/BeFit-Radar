// This file MUST live at the ROOT of your deployed site, e.g. public/firebase-messaging-sw.js
// (Vite copies everything in /public as-is to the build output root.)
// It cannot use ES module imports - it loads the Firebase compat SDK from a CDN instead,
// because the browser runs it as a raw background script before your app's bundler exists.

importScripts('https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging-compat.js');

// ⚠️ IMPORTANT: this must be the EXACT SAME config values as the ones in your real firebase.js.
firebase.initializeApp({
  apiKey: "AIzaSy...",
  authDomain: "befit-facility.firebaseapp.com",
  projectId: "befit-facility",
  storageBucket: "befit-facility.appspot.com",
  messagingSenderId: "...",
  appId: "..."
});

const messaging = firebase.messaging();

// Fires when a push arrives while the browser/tab is closed or in the background.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || 'BeFit Eye';
  const body = payload.notification?.body || payload.data?.body || 'You have a new notification.';

  self.registration.showNotification(title, {
    body,
    icon: '/vite.svg', // replace with your own app icon path if you have one, e.g. '/logo192.png'
    badge: '/vite.svg',
    requireInteraction: true,
    vibrate: [500, 200, 500, 200, 500],
    data: payload.data || {}
  });
});

// Clicking the notification focuses/opens the app instead of doing nothing.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
