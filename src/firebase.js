import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth } from "firebase/auth";
import { getMessaging, isSupported } from "firebase/messaging";
import { getFunctions } from "firebase/functions";

// ⚠️ IMPORTANT: this must be the EXACT SAME config object as the one already
// in your real firebase.js (the values below are placeholders).
const firebaseConfig = {
  apiKey: "AIzaSyAt08VDdRMJmdyVAwRoGgHS5--h2cisNuc",
  authDomain: "befit-facility.firebaseapp.com",
  projectId: "befit-facility",
  storageBucket: "befit-facility.appspot.com",
  messagingSenderId: "518274931931",
  appId: "1:518274931931:web:f8c701d4ef744c2fee80fe"
};

const app = initializeApp(firebaseConfig);
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
