import { useState, type FormEvent } from 'react';
import { signOut, type User } from 'firebase/auth';
import { z } from 'zod';
import { AuditApi, RequestFailure } from './api.js';
import {
  auth,
  createAccountAndSendVerification,
  resendVerificationEmail,
  signIn,
  signInErrorMessage,
  signInWithEmail,
} from './auth.js';

export function GoogleIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="google-g-icon"
    >
      <path
        fill="#4285F4"
        d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
      />
    </svg>
  );
}

const VerificationStatusResponse = z.object({
  schemaVersion: z.literal('1.0'),
  status: z.enum(['approved', 'pending', 'rejected', 'unregistered']),
  emailVerified: z.boolean(),
  isAdmin: z.boolean(),
});

const SubmitVerificationResponse = z.object({
  schemaVersion: z.literal('1.0'),
  request: z.object({
    uid: z.string(),
    status: z.enum(['pending', 'approved', 'rejected']),
  }),
});

export interface SignInPageProps {
  initialMode?: 'signin' | 'create-account';
  onNavigate: (
    route: 'home' | 'signin' | 'create-account' | 'admin' | 'profile',
  ) => void;
  onAuthenticated: () => void;
}

export function AuthBrandPanel() {
  return (
    <aside className="split-auth-left" aria-label="About Siphon">
      <div className="split-auth-brand">
        <span className="split-auth-mark" aria-hidden="true">
          S
        </span>
        <span className="split-auth-brand-name">Siphon</span>
      </div>
      <div className="split-auth-copy">
        <p className="split-auth-kicker">
          <span className="status-dot" aria-hidden="true" /> SCIENTIFIC
          SIMULATION AUDIT
        </p>
        <h2>
          Evidence for your <em>simulation.</em>
        </h2>
        <p className="split-auth-lead">
          Inspect Python heat-diffusion and orbital-dynamics models with
          deterministic conservation checks and structured reports.
        </p>
        <ul className="split-auth-bullets">
          <li>Inspect Heat Diffusion and Orbital Dynamics models</li>
          <li>Verify conservation laws with deterministic checks</li>
          <li>Download structured evidence reports and PDFs</li>
        </ul>
      </div>
    </aside>
  );
}

export function SignInPage({
  initialMode = 'signin',
  onNavigate,
  onAuthenticated,
}: SignInPageProps) {
  const mode = initialMode;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [unverifiedUser, setUnverifiedUser] = useState<User | null>(null);

  const isCreateValid =
    name.trim().length > 0 &&
    email.trim().length > 0 &&
    phone.trim().length >= 5 &&
    password.length >= 6 &&
    confirmPassword.length > 0 &&
    password === confirmPassword;

  const isSignInValid = email.trim().length > 0 && password.length > 0;

  const switchMode = (nextMode: 'signin' | 'create-account') => {
    setError('');
    setNotice('');
    setUnverifiedUser(null);
    onNavigate(nextMode);
  };

  const handleGoogleSignIn = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    setNotice('');
    setUnverifiedUser(null);
    try {
      await signIn();
      const currentUser = auth?.currentUser;
      if (!currentUser) {
        onAuthenticated();
        return;
      }
      const api = new AuditApi(currentUser);
      const status = await api.get(
        '/auth/verification-status',
        VerificationStatusResponse,
      );
      if (status.status !== 'approved') {
        if (auth) await signOut(auth);
        setNotice(
          status.status === 'rejected'
            ? 'Your account verification request was declined by the administrator.'
            : status.status === 'pending'
              ? 'Your account is waiting for administrator approval. You will be able to sign in once approved.'
              : 'Administrator approval is required before accessing the workspace. Please create an account and submit a verification request.',
        );
        return;
      }
      onAuthenticated();
    } catch (reason) {
      if (reason instanceof RequestFailure) {
        setError(reason.message);
      } else {
        setError(signInErrorMessage(reason));
      }
    } finally {
      setPending(false);
    }
  };

  const handleSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!isSignInValid || pending) return;
    setPending(true);
    setError('');
    setNotice('');
    setUnverifiedUser(null);
    try {
      const user = await signInWithEmail(email.trim(), password);
      if (!user.emailVerified) {
        setUnverifiedUser(user);
        setError(
          'Your email is not verified yet. Check your inbox and verify your email before signing in.',
        );
        return;
      }
      const api = new AuditApi(user);
      const status = await api.get(
        '/auth/verification-status',
        VerificationStatusResponse,
      );
      if (status.status !== 'approved') {
        if (auth) await signOut(auth);
        setNotice(
          status.status === 'rejected'
            ? 'Your account verification request was declined by the administrator.'
            : 'Your email is verified, and your account is waiting for administrator approval. You will be able to sign in once approved.',
        );
        return;
      }
      onAuthenticated();
    } catch (reason) {
      if (reason instanceof RequestFailure) {
        setError(reason.message);
      } else {
        setError(signInErrorMessage(reason));
      }
    } finally {
      setPending(false);
    }
  };

  const handleCreateAccount = async (event: FormEvent) => {
    event.preventDefault();
    if (!isCreateValid || pending) return;
    setPending(true);
    setError('');
    setNotice('');
    try {
      const user = await createAccountAndSendVerification(
        name.trim(),
        email.trim(),
        password,
      );
      const api = new AuditApi(user);
      await api.mutate(
        '/auth/verification-request',
        'POST',
        { name: name.trim(), phone: phone.trim() },
        SubmitVerificationResponse,
      );
      if (auth) await signOut(auth);
      setNotice(
        `Verification email sent to ${email.trim()}, and your account request has been sent to the administrator for approval. Once both your email is verified and your account is approved, you can sign in.`,
      );
      setName('');
      setPhone('');
      setPassword('');
      setConfirmPassword('');
      onNavigate('signin');
    } catch (reason) {
      if (reason instanceof RequestFailure) {
        setError(reason.message);
      } else {
        setError(signInErrorMessage(reason));
      }
    } finally {
      setPending(false);
    }
  };

  const handleResend = async () => {
    if (!unverifiedUser || pending) return;
    setPending(true);
    setError('');
    try {
      await resendVerificationEmail(unverifiedUser);
      setNotice(
        `Verification email resent to ${unverifiedUser.email ?? email}.`,
      );
      if (auth) await signOut(auth);
      setUnverifiedUser(null);
    } catch (reason) {
      setError(signInErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="split-auth-shell">
      <AuthBrandPanel />
      <main className="split-auth-right" aria-labelledby="auth-page-title">
        <div className="split-auth-topbar">
          <a
            href="/"
            className="split-auth-back"
            onClick={(event) => {
              event.preventDefault();
              onNavigate('home');
            }}
          >
            ← Back to Siphon
          </a>
          <div className="split-auth-toplinks">
            {mode === 'signin' ? (
              <span>
                New here?{' '}
                <a
                  href="/create-account"
                  onClick={(event) => {
                    event.preventDefault();
                    switchMode('create-account');
                  }}
                >
                  Create account ↗
                </a>
              </span>
            ) : (
              <span>
                Already have an account?{' '}
                <a
                  href="/signin"
                  onClick={(event) => {
                    event.preventDefault();
                    switchMode('signin');
                  }}
                >
                  Sign in ↗
                </a>
              </span>
            )}
            <span aria-hidden="true">·</span>
            <a
              href="/admin"
              className="split-auth-admin-link"
              onClick={(event) => {
                event.preventDefault();
                onNavigate('admin');
              }}
            >
              Admin ↗
            </a>
          </div>
        </div>

        <div className="split-auth-form-wrap">
          <p className="split-auth-eyebrow">
            {mode === 'signin' ? 'WELCOME BACK' : 'ACCOUNT VERIFICATION'}
          </p>
          <h1 id="auth-page-title" className="split-auth-title">
            {mode === 'signin' ? 'Sign in to Siphon.' : 'Create your account.'}
          </h1>
          <p className="split-auth-subtitle">
            {mode === 'signin'
              ? 'Sign in with your verified email and password.'
              : 'Enter your details to submit your account for verification.'}
          </p>

          {error && (
            <div className="split-auth-error" role="alert">
              {error}
              {unverifiedUser && (
                <div style={{ marginTop: '0.65rem' }}>
                  <button
                    type="button"
                    className="split-auth-secondary-btn"
                    disabled={pending}
                    onClick={() => void handleResend()}
                  >
                    Resend verification email
                  </button>
                </div>
              )}
            </div>
          )}

          {notice && (
            <div className="split-auth-notice" role="status">
              {notice}
            </div>
          )}

          {mode === 'signin' ? (
            <div className="split-auth-form">
              <button
                type="button"
                className="split-auth-google-btn"
                disabled={!auth || pending}
                onClick={() => void handleGoogleSignIn()}
              >
                <GoogleIcon />
                <span>Sign in with Google</span>
              </button>

              <div className="split-auth-divider">
                <span>or continue with email</span>
              </div>

              <form
                className="split-auth-form"
                onSubmit={(e) => void handleSignIn(e)}
              >
              <label className="split-auth-field">
                <span>Email address</span>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label className="split-auth-field">
                <span>Password</span>
                <div className="split-auth-password-wrap">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="split-auth-show-btn"
                    onClick={() => setShowPassword((prev) => !prev)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              <button
                type="submit"
                className="split-auth-submit"
                disabled={!auth || !isSignInValid || pending}
              >
                {pending ? 'Signing in…' : 'Sign in'}
              </button>
              <div className="split-auth-bottom-links">
                <a
                  href="/create-account"
                  onClick={(event) => {
                    event.preventDefault();
                    switchMode('create-account');
                  }}
                >
                  Create an account
                </a>
              </div>
              </form>
            </div>
          ) : (
            <form
              className="split-auth-form"
              onSubmit={(e) => void handleCreateAccount(e)}
            >
              <label className="split-auth-field">
                <span>Name</span>
                <input
                  type="text"
                  autoComplete="name"
                  placeholder="Your full name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </label>
              <label className="split-auth-field">
                <span>Email</span>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label className="split-auth-field">
                <span>Phone number</span>
                <input
                  type="tel"
                  autoComplete="tel"
                  placeholder="+1 555 010 1234"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  required
                />
              </label>
              <label className="split-auth-field">
                <span>Create password</span>
                <div className="split-auth-password-wrap">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="At least 6 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="split-auth-show-btn"
                    onClick={() => setShowPassword((prev) => !prev)}
                  >
                    {showPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              <label className="split-auth-field">
                <span>Re-enter password</span>
                <div className="split-auth-password-wrap">
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                  />
                  <button
                    type="button"
                    className="split-auth-show-btn"
                    onClick={() => setShowConfirmPassword((prev) => !prev)}
                  >
                    {showConfirmPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
              </label>
              {confirmPassword.length > 0 && password !== confirmPassword && (
                <small className="split-auth-hint-error">
                  Passwords do not match.
                </small>
              )}
              {password.length > 0 && password.length < 6 && (
                <small className="split-auth-hint-error">
                  Password must be at least 6 characters.
                </small>
              )}
              <button
                type="submit"
                className="split-auth-submit"
                disabled={!auth || !isCreateValid || pending}
              >
                {pending ? 'Submitting…' : 'Verify Account'}
              </button>
              <div className="split-auth-bottom-links">
                <a
                  href="/signin"
                  onClick={(event) => {
                    event.preventDefault();
                    switchMode('signin');
                  }}
                >
                  Back to Sign in
                </a>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
