// This file MUST live at the ROOT of your deployed site, e.g. public/firebase-messaging-sw.js
// (Vite copies everything in /public as-is to the build output root.)
// It cannot use ES module imports - it loads the Firebase compat SDK from a CDN instead,
// because the browser runs it as a raw background script before your app's bundler exists.

importScripts('https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAt08VDdRMJmdyVAwRoGgHS5--h2cisNuc",
  authDomain: "befit-facility.firebaseapp.com",
  projectId: "befit-facility",
  storageBucket: "befit-facility.appspot.com",
  messagingSenderId: "518274931931",
  appId: "1:518274931931:web:f8c701d4ef744c2fee80fe"
});

const messaging = firebase.messaging();

// Fires when a push arrives while the browser/tab is closed or in the background.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || payload.data?.title || 'BeFit Eye';
  const body = payload.notification?.body || payload.data?.body || 'You have a new notification.';

  // tag + renotify: if several pushes arrive about the same request (or the same type of
  // request), the phone re-alerts (sound/vibration) every single time instead of silently
  // swallowing the 2nd/3rd one because it looks like "the same notification already shown".
  const tag = payload.data?.requestId || payload.data?.type || payload.fcmOptions?.tag || 'befit-eye';

  self.registration.showNotification(title, {
    body,
    // NOTE: these icons live at the ROOT of /public (icon-192.png / icon-512.png), not under
    // /icons/ - the old /icons/icon-192.png path 404'd, which can make Chrome fall back to a
    // generic/blank icon and the notification feel weaker/less noticeable.
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    requireInteraction: true,
    vibrate: [500, 200, 500, 200, 500],
    tag,
    renotify: true,
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
