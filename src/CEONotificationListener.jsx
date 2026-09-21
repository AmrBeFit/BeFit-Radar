import React, { useEffect } from 'react';
import { db } from './firebase';
import { collection, onSnapshot } from 'firebase/firestore';

export default function CEONotificationListener() {
  useEffect(() => {
    console.log("🚀 Notification Listener is now active and listening...");

    // استماع عام ومباشر لكل ما يدخل في collection 'requests'
    const unsubscribe = onSnapshot(collection(db, 'requests'), (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          console.log("📥 New Document Added to Firestore:", data);

          // إظهار تنبيه فوراً بغض النظر عن الشروط
          alert(`🔔 NEW REQUEST RECEIVED!\nTitle/Details: ${data.title || data.details || 'New Request'}`);
        }
      });
    }, (error) => {
      console.error("❌ Firestore Listener Error:", error);
    });

    return () => unsubscribe();
  }, []);

  return null;
}