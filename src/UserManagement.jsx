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
  // حالة نموذج الإضافة
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    role: 'User',
    assignedBranch: ''
  });

  // حالة البيانات
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [loading, setLoading] = useState(false);

  // حالة التعديل
  const [editingUserId, setEditingUserId] = useState(null);
  const [editName, setEditName] = useState('');

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

  // 2. تحديث قيم المدخلات
  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  // 3. إضافة مستخدم جديد وتحديد فرعه
  const handleAddUser = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // الـ Branch Manager يضيف دور User دائماً
      const assignedRole = currentUserRole === 'BRANCH_MANAGER' ? 'User' : formData.role;

      await addDoc(collection(db, 'users'), {
        displayName: formData.username,
        passwordText: formData.password,
        role: assignedRole,
        assignedBranch: formData.assignedBranch,
        createdAt: serverTimestamp()
      });

      alert('تمت إضافة المستخدم بنجاح');
      setFormData({ username: '', password: '', role: 'User', assignedBranch: '' });
      fetchUsers(); // تحديث القائمة
    } catch (error) {
      console.error('خطأ أثناء إضافة المستخدم:', error);
      alert('حدث خطأ: ' + error.message);
    } finally {
      setLoading(false);
    }
  };

  // 4. حفظ تعديل اسم المستخدم
  const handleUpdateName = async (userId) => {
    if (!editName.trim()) return;
    try {
      const userRef = doc(db, 'users', userId);
      await updateDoc(userRef, {
        displayName: editName
      });
      alert('تم تحديث الاسم بنجاح');
      setEditingUserId(null);
      setEditName('');
      fetchUsers();
    } catch (error) {
      console.error('خطأ في التعديل:', error);
      alert('فشل التعديل: ' + error.message);
    }
  };

  // 5. حذف مستخدم
  const handleDeleteUser = async (userId) => {
    if (window.confirm('هل أنت تأكد من حذف هذا المستخدم؟')) {
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
    <div style={{ display: 'flex', gap: '20px', padding: '20px' }}>
      {/* الجزء الأيسر: نموذج الإضافة */}
      <div style={{ flex: '1', border: '1px solid #ddd', padding: '20px', borderRadius: '8px' }}>
        <h3>Add New User</h3>
        <form onSubmit={handleAddUser}>
          <div style={{ marginBottom: '10px' }}>
            <label>Username</label>
            <input
              type="text"
              name="username"
              value={formData.username}
              onChange={handleChange}
              required
              style={{ width: '100%', padding: '8px', marginTop: '5px' }}
            />
          </div>

          <div style={{ marginBottom: '10px' }}>
            <label>Password</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
              style={{ width: '100%', padding: '8px', marginTop: '5px' }}
            />
          </div>

          <div style={{ marginBottom: '10px' }}>
            <label>User Role</label>
            {currentUserRole === 'BRANCH_MANAGER' ? (
              <input
                type="text"
                value="User"
                disabled
                style={{ width: '100%', padding: '8px', marginTop: '5px', backgroundColor: '#f0f0f0' }}
              />
            ) : (
              <select
                name="role"
                value={formData.role}
                onChange={handleChange}
                style={{ width: '100%', padding: '8px', marginTop: '5px' }}
              >
                <option value="User">User</option>
                <option value="Branch Manager">Branch Manager</option>
                <option value="Admin">Admin</option>
              </select>
            )}
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label>Assign Branches</label>
            <select
              name="assignedBranch"
              value={formData.assignedBranch}
              onChange={handleChange}
              required
              style={{ width: '100%', padding: '8px', marginTop: '5px' }}
            >
              <option value="">Select Branch</option>
              {branches.map(b => (
                <option key={b.id} value={b.name || b.id}>
                  {b.name || b.id}
                </option>
              ))}
            </select>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{ width: '100%', padding: '10px', backgroundColor: '#5850ec', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
          >
            {loading ? 'Adding...' : 'Add User'}
          </button>
        </form>
      </div>

      {/* الجزء الأيمن: جدول عرض وتعديل وحذف المستخدمين */}
      <div style={{ flex: '2', border: '1px solid #ddd', padding: '20px', borderRadius: '8px' }}>
        <h3>System Users ({users.length})</h3>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '2px solid #ddd' }}>
              <th style={{ padding: '8px' }}>USERNAME</th>
              <th style={{ padding: '8px' }}>ROLE</th>
              <th style={{ padding: '8px' }}>ASSIGNED BRANCHES</th>
              <th style={{ padding: '8px' }}>ACTION</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 ? (
              <tr>
                <td colSpan="4" style={{ textAlign: 'center', padding: '20px' }}>No users found.</td>
              </tr>
            ) : (
              users.map(u => (
                <tr key={u.id} style={{ borderBottom: '1px solid #eee' }}>
                  <td style={{ padding: '8px' }}>
                    {editingUserId === u.id ? (
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                      />
                    ) : (
                      u.displayName || u.username
                    )}
                  </td>
                  <td style={{ padding: '8px' }}>{u.role}</td>
                  <td style={{ padding: '8px' }}>{u.assignedBranch || 'N/A'}</td>
                  <td style={{ padding: '8px' }}>
                    {editingUserId === u.id ? (
                      <>
                        <button onClick={() => handleUpdateName(u.id)} style={{ marginRight: '5px' }}>Save</button>
                        <button onClick={() => setEditingUserId(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button 
                          onClick={() => { setEditingUserId(u.id); setEditName(u.displayName || u.username); }}
                          style={{ marginRight: '5px' }}
                        >
                          Edit Name
                        </button>
                        <button 
                          onClick={() => handleDeleteUser(u.id)}
                          style={{ backgroundColor: '#ff4d4f', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px' }}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}