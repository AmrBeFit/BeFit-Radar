import React, { useState } from 'react';
import { db } from './firebase';
import { collection, getDocs } from 'firebase/firestore';

export default function Login({ onLoginSuccess }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    const cleanInput = identifier.trim().toLowerCase();
    const cleanPassword = password.trim();

    if (!cleanInput || !cleanPassword) {
      setError('Please enter both username/email and password.');
      return;
    }

    setLoading(true);

    try {
      console.log("🔍 Searching for user:", cleanInput);

      let foundUser = null;
      const collectionsToTry = ['Users', 'users'];

      for (const colName of collectionsToTry) {
        if (foundUser) break;

        const colRef = collection(db, colName);
        const snap = await getDocs(colRef);
        
        snap.forEach(doc => {
          const data = doc.data();

          const email = String(data.email || '').trim().toLowerCase();
          const username = String(data.username || '').trim().toLowerCase();
          const displayName = String(data.displayName || '').trim().toLowerCase();

          if (cleanInput === email || cleanInput === username || cleanInput === displayName) {
            foundUser = { id: doc.id, ...data };
          }
        });
      }

      if (!foundUser) {
        setError('User not found. Please check your credentials.');
        return;
      }

      const dbPassword = String(foundUser.passwordText || foundUser.password || '').trim();

      if (dbPassword === cleanPassword) {
        console.log("✅ Logged in successfully:", foundUser);
        onLoginSuccess(foundUser);
      } else {
        setError('Incorrect password. Please try again.');
      }

    } catch (err) {
      console.error('❌ Database error:', err);
      setError('Database Error: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col items-center justify-center p-4" dir="ltr">
      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full space-y-6 border">
        
        <div className="text-center">
          <h1 className="text-3xl font-black text-gray-900 tracking-tight">BeFit Eye</h1>
          <p className="text-xs text-gray-500 mt-1">Please log in to continue</p>
        </div>

        {error && (
          <div className="bg-red-50 text-red-600 text-xs p-3 rounded-lg border border-red-200 text-center font-medium">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Username or Email
            </label>
            <input
              type="text"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter username or email"
              className="w-full p-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 text-sm focus:outline-none"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="w-full p-2.5 border rounded-lg focus:ring-2 focus:ring-blue-500 text-sm focus:outline-none"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2.5 rounded-lg text-sm transition shadow disabled:bg-blue-300 cursor-pointer"
          >
            {loading ? 'Logging in...' : 'Log In'}
          </button>
        </form>

        <div className="pt-4 border-t text-center">
          <p className="text-[11px] font-extrabold text-gray-400 uppercase tracking-wider">
            POWERED BY Amr Shata
          </p>
        </div>

      </div>
    </div>
  );
}