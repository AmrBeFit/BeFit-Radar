import { useEffect } from 'react';
import { db, messagingPromise } from './firebase';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { getToken, onMessage } from 'firebase/messaging';

// ⚠️ Paste the VAPID key you generate in:
// Firebase Console -> Project Settings -> Cloud Messaging -> Web configuration -> "Generate key pair"
const VAPID_KEY = 'PASTE_YOUR_VAPID_KEY_HERE';

// Mount this once, anywhere inside the logged-in area (e.g. right next to <CEONotificationListener />
// in App.jsx). It silently registers this browser/device to receive push notifications for this
// account, so a push still arrives even if the browser is fully closed.
export default function PushNotificationSetup({ user }) {
  useEffect(() => {
    if (!user?.id) return;

    let unsubscribeForeground = () => {};

    (async () => {
      const messaging = await messagingPromise;
      if (!messaging) return; // unsupported browser - fail silently, the in-app alerts still work

      if (!('serviceWorker' in navigator)) return;

      try {
        // Register the background service worker (public/firebase-messaging-sw.js)
        const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');

        // Only fetch a token once permission is actually granted (granted elsewhere in the app,
        // e.g. by CEONotificationListener's silent first-interaction unlock).
        if (Notification.permission !== 'granted') return;

        const token = await getToken(messaging, {
          vapidKey: VAPID_KEY,
          serviceWorkerRegistration: registration
        });

        if (token) {
          // Save this device's token onto the account, so the Cloud Function can push to it later.
          // arrayUnion avoids duplicates if the same device registers more than once.
          await updateDoc(doc(db, 'users', user.id), {
            fcmTokens: arrayUnion(token)
          }).catch(() => {});
        }
      } catch (err) {
        console.log('Push registration skipped:', err.message);
      }

      // While the tab is open and focused, the existing CEONotificationListener (Firestore
      // listener + local sound) already handles alerts - so we intentionally do nothing extra
      // here to avoid a duplicate sound/alert firing at the same time.
      unsubscribeForeground = onMessage(messaging, () => {});
    })();

    return () => unsubscribeForeground();
  }, [user?.id]);

  return null;
}
