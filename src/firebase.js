import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getAuth } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "befit-facility.firebaseapp.com", // 👈 تأكد أن اسم المشروع BeFit Facility كما بالصورة
  projectId: "befit-facility",                 // 👈 تأكد من projectId
  storageBucket: "befit-facility.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);