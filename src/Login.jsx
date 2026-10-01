import React, { useState } from 'react';
import { db, auth } from './firebase';
import { doc, getDoc } from 'firebase/firestore';
import { signInWithEmailAndPassword } from 'firebase/auth';

// How long the "fly in and collide" entrance takes, in seconds. The eyes' idle
// animations (blink, pupil bob) don't start until after this, via SVG `begin`.
const ENTRANCE_DURATION = 1.1;

// A single cartoon eye: white sclera, a pupil shifted toward the center logo, and a
// blinking eyelid animation. `side` decides which way the pupil looks ("left" eye
// looks toward the right/center, "right" eye looks toward the left/center), which
// entrance animation it flies in with, and staggers the blink slightly so the two
// eyes don't blink in perfect unison once they've settled.
function BefitEye({ side }) {
  const pupilX = side === 'left' ? 62 : 38;
  const highlightX = side === 'left' ? 67 : 33;
  const idleBegin = side === 'left' ? `${ENTRANCE_DURATION}s` : `${ENTRANCE_DURATION + 0.18}s`;
  const entranceClass = side === 'left' ? 'befit-eye-enter-left' : 'befit-eye-enter-right';

  return (
    <svg
      viewBox="0 0 100 80"
      className={`w-16 h-14 sm:w-20 sm:h-16 ${entranceClass}`}
      aria-hidden="true"
    >
      <ellipse cx="50" cy="40" rx="48" ry="36" fill="#ffffff" stroke="#0f172a" strokeWidth="5" />
      <circle cx={pupilX} cy="40" r="17" fill="#0f172a">
        <animate attributeName="cy" values="40;38;40" dur="3.2s" begin={idleBegin} repeatCount="indefinite" />
      </circle>
      <circle cx={highlightX} cy="32" r="4.5" fill="#ffffff" />
      {/* Eyelid: tucked away above the eye, sweeps down to fully cover it for a quick blink */}
      <rect x="0" y="-80" width="100" height="80" rx="36" fill="#ffffff">
        <animate
          attributeName="y"
          values="-80;-80;0;-80;-80"
          keyTimes="0;0.55;0.63;0.7;1"
          dur="4.5s"
          begin={idleBegin}
          repeatCount="indefinite"
        />
      </rect>
    </svg>
  );
}

// "BeFit Eye" set along a smiling arc (a gentle curve, dipping in the middle) instead of
// a straight line, using SVG text-on-a-path.
function BefitSmileTitle() {
  return (
    <svg viewBox="0 0 320 130" className="w-72 sm:w-80 mx-auto block" aria-label="BeFit Eye">
      <path id="befitSmileArc" d="M 4 6 Q 160 124 316 6" fill="none" />
      <text textAnchor="middle" style={{ fontFamily: 'inherit', fontWeight: 900, fontSize: '38px', fill: '#111827', letterSpacing: '0px' }}>
        <textPath href="#befitSmileArc" startOffset="50%">BeFit Eye</textPath>
      </text>
    </svg>
  );
}

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
      {/* Entrance animation, played once on load: the two eyes fly in from off-screen, meet (and
          slightly overshoot) in the middle as if they collided, the red BeFit logo pops out of
          that collision, and the eyes settle back apart on either side, gazing at the logo. */}
      <style>{`
        @keyframes befitEyeEnterLeft {
          0%   { transform: translateX(-140vw); }
          55%  { transform: translateX(30px); }
          72%  { transform: translateX(-6px); }
          100% { transform: translateX(0); }
        }
        @keyframes befitEyeEnterRight {
          0%   { transform: translateX(140vw); }
          55%  { transform: translateX(-30px); }
          72%  { transform: translateX(6px); }
          100% { transform: translateX(0); }
        }
        @keyframes befitLogoPop {
          0%, 50% { transform: scale(0); opacity: 0; }
          68%     { transform: scale(1.28); opacity: 1; }
          82%     { transform: scale(0.92); }
          100%    { transform: scale(1); opacity: 1; }
        }
        .befit-eye-enter-left { animation: befitEyeEnterLeft 1.1s cubic-bezier(.22,.61,.36,1) both; }
        .befit-eye-enter-right { animation: befitEyeEnterRight 1.1s cubic-bezier(.22,.61,.36,1) both; }
        .befit-logo-pop { animation: befitLogoPop 1.1s ease-out both; }
        @media (prefers-reduced-motion: reduce) {
          .befit-eye-enter-left, .befit-eye-enter-right, .befit-logo-pop { animation: none; }
        }
      `}</style>

      <div className="bg-white p-8 rounded-2xl shadow-xl max-w-md w-full space-y-6 border">

        <div className="text-center">
          <div className="flex items-center justify-center gap-2 sm:gap-3 mb-0">
            <BefitEye side="left" />
            <img
              src="/befit-logo-red.jpg"
              alt="BeFit"
              className="befit-logo-pop w-16 h-16 sm:w-20 sm:h-20 rounded-2xl shadow-lg object-cover shrink-0"
            />
            <BefitEye side="right" />
          </div>
          <BefitSmileTitle />
          <p className="text-xs text-gray-500 -mt-10">Please log in to continue</p>
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
