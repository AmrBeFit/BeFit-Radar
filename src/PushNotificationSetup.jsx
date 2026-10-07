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
    let removeVisibility = () => {};
    let removeSwMessage = () => {};

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

        // Registers (or refreshes) this device's token on the account. Retries once on failure (a transient
        // network/service-worker hiccup on first load is common).
        const syncToken = async () => {
          let token = null;
          for (let attempt = 0; attempt < 2 && !token; attempt++) {
            try {
              token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
            } catch (e) {
              if (attempt === 1) throw e;
              await new Promise((r) => setTimeout(r, 1500));
            }
          }
          if (token) {
            // arrayUnion avoids duplicates if the same device registers more than once.
            await updateDoc(doc(db, 'users', user.id), { fcmTokens: arrayUnion(token) }).catch(() => {});
          }
        };
        await syncToken();

        // A token can change silently (browser update, cleared data, long idle). Re-check it whenever the
        // person comes back to the app, at most once every 6 hours, so a device never goes quiet unnoticed.
        let lastSync = Date.now();
        const onVisible = () => {
          if (document.visibilityState !== 'visible') return;
          if (Date.now() - lastSync < 6 * 60 * 60 * 1000) return;
          lastSync = Date.now();
          syncToken().catch(() => {});
        };
        document.addEventListener('visibilitychange', onVisible);
        removeVisibility = () => document.removeEventListener('visibilitychange', onVisible);
      } catch (err) {
        console.log('Push registration skipped:', err.message);
      }

      // FIX: while the tab is open and focused, Chrome/Android do NOT show a system notification
      // on their own for an incoming push - this used to be left empty on purpose, on the
      // assumption that CEONotificationListener's own Firestore listener + sound already covers
      // it. But that listener only watches new CEO requests - it says nothing for every other
      // push type (Buzz, leave-request updates, request assignment/completion, stale/absence
      // reminders...), so for every one of those, the push silently arrived and nothing ever
      // appeared on screen whenever the tab happened to be open. We now show it ourselves here,
      // the same way the OS would if the tab were closed, so nothing gets lost either way.
      unsubscribeForeground = onMessage(messaging, async (payload) => {
        const title = payload?.notification?.title || payload?.data?.title || 'BeFit Eye';
        const body = payload?.notification?.body || payload?.data?.body || '';
        const data = payload?.data || {};
        const tag = data.requestId || data.type || 'befit-eye';
        try {
          if (Notification.permission !== 'granted') return;
          // Android Chrome refuses `new Notification(...)` ("Illegal constructor"), so the system
          // notification is always raised through the service worker, which works everywhere.
          const reg = await navigator.serviceWorker.getRegistration('/firebase-messaging-sw.js')
            || await navigator.serviceWorker.ready;
          await reg.showNotification(title, {
            body,
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            tag,
            renotify: true,
            requireInteraction: true,
            vibrate: data.urgent === '1' ? [800, 200, 800, 200, 800, 200, 800] : [500, 200, 500, 200, 500],
            data
          });
        } catch (e) {
          try { const n = new Notification(title, { body }); n.onclick = () => { window.focus(); n.close(); }; } catch (e2) { /* ignore */ }
        }
      });

      // Tapping a notification while the app is already open: the service worker tells the app which screen to show.
      const onSwMessage = (event) => {
        if (event?.data?.type === 'PUSH_NAVIGATE') {
          window.dispatchEvent(new CustomEvent('befit-push-navigate', { detail: event.data }));
        }
      };
      navigator.serviceWorker.addEventListener('message', onSwMessage);
      removeSwMessage = () => navigator.serviceWorker.removeEventListener('message', onSwMessage);

      // Opened from a notification while the app was closed: the link carries ?tab=...
      try {
        const params = new URLSearchParams(window.location.search);
        const tab = params.get('tab');
        if (tab) {
          window.dispatchEvent(new CustomEvent('befit-push-navigate', { detail: { type: 'PUSH_NAVIGATE', tab } }));
          params.delete('tab');
          const qs = params.toString();
          window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
        }
      } catch (e) { /* ignore */ }
    })();

    return () => { unsubscribeForeground(); removeVisibility(); removeSwMessage(); };
  }, [user?.id]);

  return null;
}
