import { useEffect } from 'react';
import { db, messagingPromise } from './firebase';
import { doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { getToken, onMessage } from 'firebase/messaging';

// ⚠️ Paste the VAPID key you generate in:
// Firebase Console -> Project Settings -> Cloud Messaging -> Web configuration -> "Generate key pair"
const VAPID_KEY = 'BD6vr5znvsM9R7wtu8m9Q5WyRv2x4ytlWmvyO3hK0axWdy2zTKZhgd4l_icuYpp29huOSx1QZWN12DWgQydG0KY';

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

        // FIX: this effect only runs once per login (its dependency is just user.id). Before, it
        // checked `Notification.permission` a single time and quietly gave up if it wasn't
        // 'granted' yet - but the permission prompt (asked elsewhere, e.g. CEONotificationListener)
        // is answered by the person a moment AFTER this effect already ran, so on a lot of first
        // logins the token never got registered at all, even though the person tapped "Allow".
        // That's a likely reason some devices "never receive anything": they simply never had a
        // token saved. Now we ask for permission ourselves if it's still undecided, and wait for
        // the real answer before giving up, so a device that allows notifications always ends up
        // registered on this same pass.
        let permission = Notification.permission;
        if (permission === 'default') {
          permission = await Notification.requestPermission().catch(() => 'denied');
        }
        if (permission !== 'granted') return;

        // Retry once on failure (a transient network/service-worker hiccup on first load is common
        // and otherwise silently drops the registration for that device).
        let token = null;
        for (let attempt = 0; attempt < 2 && !token; attempt++) {
          try {
            token = await getToken(messaging, {
              vapidKey: VAPID_KEY,
              serviceWorkerRegistration: registration
            });
          } catch (e) {
            if (attempt === 1) throw e;
            await new Promise((r) => setTimeout(r, 1500));
          }
        }

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
