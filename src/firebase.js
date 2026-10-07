import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth } from "firebase/auth";
import { getMessaging, isSupported } from "firebase/messaging";
import { getFunctions } from "firebase/functions";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";

const firebaseConfig = {
  apiKey: "AIzaSyAt08VDdRMJmdyVAwRoGgHS5--h2cisNuc",
  authDomain: "befit-facility.firebaseapp.com",
  projectId: "befit-facility",
  storageBucket: "befit-facility.appspot.com",
  messagingSenderId: "518274931931",
  appId: "1:518274931931:web:f8c701d4ef744c2fee80fe"
};

const app = initializeApp(firebaseConfig);

// App Check: proves requests come from the real BeFit Eye site (must run before the services below).
if (typeof window !== "undefined") {
  // Lets you test on localhost: copy the debug token printed in the console and register it in
  // Firebase Console > App Check > Apps > Manage debug tokens.
  if (location.hostname === "localhost") self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
  initializeAppCheck(app, {
    provider: new ReCaptchaEnterpriseProvider("6LcZbOMtAAAAALRoH4LB1yiu2hbXeoS1ny3GzCwV"),
    isTokenAutoRefreshEnabled: true
  });
}

export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);

// Update: Cloud Functions client - used to call secure server-side operations
// (creating a user, resetting someone else's password, deleting a user) that must never
// run directly in the browser once real authentication is in place.
export const functions = getFunctions(app);

// Firebase Cloud Messaging (push notifications).
export const messagingPromise = (async () => {
  try {
    const supported = await isSupported();
    if (!supported) return null;
    return getMessaging(app);
  } catch (e) {
    console.log("Firebase Messaging not supported in this browser:", e);
    return null;
  }
})();
