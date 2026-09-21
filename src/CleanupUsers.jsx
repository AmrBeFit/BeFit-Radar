import React, { useState } from 'react';
import { db } from './firebase';
import { collection, getDocs, deleteDoc, doc } from 'firebase/firestore';

export default function CleanupUsers() {
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCleanup = async () => {
    if (!window.confirm("هل أنت تأكد من أنك تريد حذف جميع المستخدمين ما عدا amrelsayed@befiteg.com؟")) {
      return;
    }

    setLoading(true);
    setStatus('جارٍ فحص المجموعات وحذف باقي المستخدمين...');

    const keepEmail = 'amrelsayed@befiteg.com';
    const collectionsToClean = ['Users', 'users'];
    let deletedCount = 0;

    try {
      for (const colName of collectionsToClean) {
        const colRef = collection(db, colName);
        const snap = await getDocs(colRef);

        for (const userDoc of snap.docs) {
          const data = userDoc.data();
          const email = String(data.email || '').trim().toLowerCase();

          // إذا لم يكن هذا البريد هو البريد المطلوب الاحتفاظ به، نقوم بحذفه
          if (email !== keepEmail) {
            await deleteDoc(doc(db, colName, userDoc.id));
            deletedCount++;
            console.log(`تم حذف المستند ID: ${userDoc.id} من المجموعة '${colName}'`);
          } else {
            console.log(`تم الإبقاء على المستخدم: ${email}`);
          }
        }
      }

      setStatus(`تمت العملية بنجاح! تم حذف ${deletedCount} مستخدم، والإبقاء على ${keepEmail} فقط.`);
    } catch (err) {
      console.error('خطأ أثناء الحذف:', err);
      setStatus('حدث خطأ أثناء الحذف: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-8 text-center space-y-4">
      <h2 className="text-xl font-bold text-red-600">أداة تنظيف المستخدمين</h2>
      <p className="text-sm text-gray-600">سيتم حذف كل الحسابات والإبقاء فقط على amrelsayed@befiteg.com</p>
      
      <button
        onClick={handleCleanup}
        disabled={loading}
        className="bg-red-600 hover:bg-red-700 text-white font-bold py-2 px-6 rounded-lg disabled:bg-gray-400"
      >
        {loading ? 'جارٍ الحذف...' : 'بدء حذف باقي المستخدمين'}
      </button>

      {status && <p className="mt-4 text-sm font-semibold">{status}</p>}
    </div>
  );
}