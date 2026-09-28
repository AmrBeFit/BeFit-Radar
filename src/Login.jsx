import React, { useState } from 'react';
import { db, auth } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { signInWithEmailAndPassword } from 'firebase/auth';

export default function Login({ onLoginSuccess }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');

    const usernameLower = identifier.trim().toLowerCase();
    const cleanPassword = password.trim();

    if (!usernameLower || !cleanPassword) {
      setError('Please enter both username and password.');
      return;
    }

    setLoading(true);

    try {
      // Step 1: turn the username the person typed into the synthetic email
      // Firebase Authentication actually needs, via the public usernameIndex lookup.
      const indexSnap = await getDoc(doc(db, 'usernameIndex', usernameLower));

      if (!indexSnap.exists()) {
        setError('User not found. Please check your credentials.');
        setLoading(false);
        return;
      }

      const { email } = indexSnap.data();

      // Step 2: the real, secure sign-in - Firebase verifies the password itself,
      // this app never sees or compares a stored password anymore.
      const credential = await signInWithEmailAndPassword(auth, email, cleanPassword);

      // Step 3: load this account's profile (role, branches, phone, etc.)
      const profileSnap = await getDoc(doc(db, 'users', credential.user.uid));

      if (!profileSnap.exists()) {
        setError('Your account was authenticated but no profile was found. Please contact an Admin.');
        setLoading(false);
        return;
      }

      const profile = { id: credential.user.uid, ...profileSnap.data() };
      onLoginSuccess(profile);

    } catch (err) {
      console.error('Login error:', err.code, err.message);
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password' || err.code === 'auth/user-not-found') {
        setError('Incorrect username or password. Please try again.');
      } else if (err.code === 'auth/too-many-requests') {
        setError('Too many attempts. Please wait a moment and try again.');
      } else {
        setError('Login error: ' + err.message);
      }
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
              Username
            </label>
            <input
              type="text"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              placeholder="Enter your username"
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
