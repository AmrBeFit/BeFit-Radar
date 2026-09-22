import React, { useState, useEffect } from 'react';
import { db } from './firebase';
import { 
  collection, 
  addDoc, 
  getDocs, 
  doc, 
  updateDoc, 
  deleteDoc, 
  serverTimestamp 
} from 'firebase/firestore';

export default function UserManagement({ currentUserRole = 'BRANCH_MANAGER' }) {
  // حالة نموذج الإضافة (تم تعديل assignedBranches ليكون مصفوفة Array)
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    role: 'User',
    assignedBranches: []
  });

  // حالة البيانات
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);

  // حالة مودال التعديل (اسم المستخدم + الفروع المخصصة)
  const [editingUser, setEditingUser] = useState(null);
  const [editName, setEditName] = useState('');
  const [editBranches, setEditBranches] = useState([]);

  // 1. جلب المستخدمين والفروع عند تحميل الصفحة
  useEffect(() => {
    fetchUsers();
    fetchBranches();
  }, []);

  const fetchUsers = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'users'));
      const usersList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setUsers(usersList);
    } catch (error) {
      console.error('خطأ في جلب المستخدمين:', error);
    }
  };

  const fetchBranches = async () => {
    try {
      const querySnapshot = await getDocs(collection(db, 'branches'));
      const branchesList = querySnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      setBranches(branchesList);
    } catch (error) {
      console.error('خطأ في جلب الفروع:', error);
    }
  };

  // 2. تحديث قيم المدخلات العادية
  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  // 3. تبديل تحديد الفروع أثناء إنشاء مستخدم جديد
  const toggleNewUserBranch = (branchName) => {
    if (formData.assignedBranches.includes(branchName)) {
      setFormData({
        ...formData,
        assignedBranches: formData.assignedBranches.filter(b => b !== branchName)
      });
    } else {
      setFormData({
        ...formData,
        assignedBranches: [...formData.assignedBranches, branchName]
      });
    }
  };

  // 4. تبديل تحديد الفروع أثناء تعديل مستخدم قائم
  const toggleEditUserBranch = (branchName) => {
    if (editBranches.includes(branchName)) {
      setEditBranches(editBranches.filter(b => b !== branchName));
    } else {
      setEditBranches([...editBranches, branchName]);
    }
  };

  // 5. إضافة مستخدم جديد مع الفروع المحددة
  const handleAddUser = async (e) => {
    e.preventDefault();
    if (formData.assignedBranches.length === 0) {
      alert('يرجى تحديد فرع واحد على الأقل للمستخدم');
      return;
    }
    setLoading(true);

    try {
      const assignedRole = currentUserRole === 'BRANCH_MANAGER' ? 'User' : formData.role;

      await addDoc(collection(db, 'users'), {
        displayName: formData.username,
        username: formData.username,
        passwordText: formData.password,
        role: assignedRole,
        assignedBranches: formData.assignedBranches, // مصفوفة الفروع
        createdAt: serverTimestamp()
      });

      alert('تمت إضافة المستخدم بنجاح');
      setFormData({ username: '', password: '', role: 'User', assignedBranches: [] });
      fetchUsers();
    } catch (error) {
      console.error('خطأ أثناء إضافة المستخدم:', error);
      alert('حدث خطأ: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // 6. فتح نافذة التعديل لمستخدم
  const handleStartEdit = (user) => {
    setEditingUser(user);
    setEditName(user.displayName || user.username || '');
    // دعم قراءة الفروع سواء كانت مصفوفة جديدة أو نص قديم
    if (Array.isArray(user.assignedBranches)) {
      setEditBranches(user.assignedBranches);
    } else if (user.assignedBranch) {
      setEditBranches([user.assignedBranch]);
    } else {
      setEditBranches([]);
    }
  };

  // 7. حفظ التعديلات (الاسم والفروع المتاحة)
  const handleSaveEdit = async () => {
    if (!editingUser) return;
    try {
      const userRef = doc(db, 'users', editingUser.id);
      await updateDoc(userRef, {
        displayName: editName,
        assignedBranches: editBranches
      });
      alert('تم تحديث بيانات المستخدم بنجاح');
      setEditingUser(null);
      fetchUsers();
    } catch (error) {
      console.error('خطأ في التعديل:', error);
      alert('فشل التعديل: ' + error.message);
    }
  };

  // 8. حذف مستخدم
  const handleDeleteUser = async (userId) => {
    if (window.confirm('هل أنت متأكد من حذف هذا المستخدم؟')) {
      try {
        await deleteDoc(doc(db, 'users', userId));
        alert('تم حذف المستخدم بنجاح');
        fetchUsers();
      } catch (error) {
        console.error('خطأ في الحذف:', error);
        alert('فشل الحذف: ' + error.message);
      }
    }
  };

  return (
    <div style={{ display: 'flex', gap: '20px', padding: '20px', fontFamily: 'sans-serif' }}>
      {/* الجزء الأيسر: نموذج الإضافة */}
      <div style={{ flex: '1', border: '1px solid #ddd', padding: '20px', borderRadius: '8px', backgroundColor: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>Add New User</h3>
        <form onSubmit={handleAddUser}>
          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Username</label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleChange}
              required
              style={{ width: '100%', padding: '8px', marginTop: '5px', boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>Password</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
              style={{ width: '100%', padding: '8px', marginTop: '5px', boxSizing: 'border-box' }}
            />
          </div>

          <div style={{ marginBottom: '10px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold' }}>User Role</label>
            {currentUserRole === 'BRANCH_MANAGER' ? (
              <input
                type="text"
                value="User"
                disabled
                style={{ width: '100%', padding: '8px', marginTop: '5px', backgroundColor: '#f0f0f0', boxSizing: 'border-box' }}
              />
            ) : (
              <select
                name="role"
                value={formData.role}
                onChange={handleChange}
                style={{ width: '100%', padding: '8px', marginTop: '5px', boxSizing: 'border-box' }}
              >
                <option value="User">User</option>
                <option value="Branch Manager">Branch Manager</option>
                <option value="Admin">Admin</option>
              </select>
            )}
          </div>

          {/* تحديد الفروع المتاحة للمستخدم الجديد */}
          <div style={{ marginBottom: '15px' }}>
            <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '5px' }}>
              Assign Branches
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '5px', maxHeight: '120px', overflowY: 'auto', border: '1px solid #ccc', padding: '8px', borderRadius: '4px' }}>
              {branches.length === 0 ? (
                <span style={{ fontSize: '12px', color: '#888' }}>لا توجد فروع متاحة</span>
              ) : (
                branches.map(b => {
                  const branchName = b.name || b.id;
                  const isSelected = formData.assignedBranches.includes(branchName);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleNewUserBranch(branchName)}
                      style={{
                        padding: '4px 8px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid #5850ec',
                        backgroundColor: isSelected ? '#5850ec' : '#fff',
                        color: isSelected ? '#fff' : '#5850ec',
                        cursor: 'pointer'
                      }}
                    >
                      {branchName} {isSelected ? '✓' : '+'}
                    </button>
                  );
                })
              )}
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: '10px', backgroundColor: '#5850ec', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
          >
            {loading ? 'Adding...' : 'Add User'}
          </button>
        </form>
      </div>

      {/* الجزء الأيمن: جدول المستخدمين الفعليين */}
      <div style={{ flex: '2', border: '1px solid #ddd', padding: '20px', borderRadius: '8px', backgroundColor: '#fff' }}>
        <h3 style={{ marginTop: 0 }}>System Users ({users.length})</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd', fontSize: '12px', color: '#666' }}>
              <th style={{ padding: '8px' }}>USERNAME</th>
              <th style={{ padding: '8px' }}>ROLE</th>
              <th style={{ padding: '8px' }}>ASSIGNED BRANCHES</th>
              <th style={{ padding: '8px', textAlign: 'right' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No users found.</td>
              </tr>
            ) : (
              users.map(u => {
                // تجميع الفروع لنفس المستخدم (سواء كانت مصفوفة أو نص فردي قديم)
                const userBranchList = Array.isArray(u.assignedBranches) 
                  ? u.assignedBranches 
                  : (u.assignedBranch ? [u.assignedBranch] : []);

                return (
                  <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                    <td style={{ padding: '8px', fontWeight: 'bold' }}>
                      {u.displayName || u.username}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ backgroundColor: '#eef2ff', color: '#4f46e5', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>
                        {u.role}
                      </span>
                    </td>
                    
                    {/* عرض الفروع كبطاقات صغيرة */}
                    <td style={{ padding: '8px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {userBranchList.length > 0 ? (
                          userBranchList.map((b, idx) => (
                            <span key={idx} style={{ backgroundColor: '#f1f5f9', color: '#334155', padding: '2px 6px', borderRadius: '4px', fontSize: '11px' }}>
                              {b}
                            </span>
                          ))
                        ) : (
                          <span style={{ color: '#999', fontSize: '11px' }}>لا توجد فروع</span>
                        )}
                      </div>
                    </td>

                    {/* الإجراءات */}
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      <button 
                        onClick={() => handleStartEdit(u)}
                        style={{ marginRight: '5px', border: '1px solid #4f46e5', backgroundColor: '#fff', color: '#4f46e5', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                      >
                        Edit
                      </button>
                      <button 
                        onClick={() => handleDeleteUser(u.id)}
                        style={{ backgroundColor: '#ff4d4f', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* نافذة تعديل بيانات المستخدم والفروع (Edit Modal) */}
      {editingUser && (
        <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyCenter: 'center', zIndex: 1000 }}>
          <div style={{ backgroundColor: '#fff', padding: '20px', borderRadius: '8px', width: '400px', margin: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
            <h4 style={{ marginTop: 0 }}>تعديل بيانات المستخدم</h4>
            
            <div style={{ marginBottom: '12px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '4px' }}>اسم المستخدم:</label>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                style={{ width: '100%', padding: '8px', boxSizing: 'border-box' }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ fontSize: '12px', fontWeight: 'bold', display: 'block', marginBottom: '6px' }}>تعديل الفروع المتاحة:</label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', maxHeight: '150px', overflowY: 'auto', border: '1px solid #ddd', padding: '8px', borderRadius: '4px' }}>
                {branches.map(b => {
                  const branchName = b.name || b.id;
                  const isSelected = editBranches.includes(branchName);
                  return (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => toggleEditUserBranch(branchName)}
                      style={{
                        padding: '4px 8px',
                        fontSize: '11px',
                        borderRadius: '4px',
                        border: '1px solid #4f46e5',
                        backgroundColor: isSelected ? '#4f46e5' : '#fff',
                        color: isSelected ? '#fff' : '#4f46e5',
                        cursor: 'pointer'
                      }}
                    >
                      {branchName} {isSelected ? '✓' : '+'}
                    </button>
                  );
                })}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
              <button 
                onClick={() => setEditingUser(null)}
                style={{ padding: '6px 12px', border: '1px solid #ccc', backgroundColor: '#fff', borderRadius: '4px', cursor: 'pointer' }}
              >
                إلغاء
              </button>
              <button 
                onClick={handleSaveEdit}
                style={{ padding: '6px 12px', backgroundColor: '#4f46e5', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold' }}
              >
                حفظ التغيرات
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}