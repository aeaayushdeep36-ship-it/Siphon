import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { signOut, type User } from 'firebase/auth';
import { z } from 'zod';
import { AuditApi, RequestFailure } from './api.js';
import {
  auth,
  signIn,
  signInErrorMessage,
  signInWithEmail,
} from './auth.js';
import { AuthBrandPanel, GoogleIcon } from './SignInPage.js';

export const ADMIN_EMAIL = 'aeaayushdeep36@gmail.com';

const VerificationRequestItem = z.object({
  schemaVersion: z.literal('1.0'),
  uid: z.string(),
  email: z.string(),
  name: z.string(),
  phone: z.string(),
  emailVerified: z.boolean(),
  status: z.enum(['pending', 'approved', 'rejected']),
  createdAt: z.string(),
  updatedAt: z.string(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
});

const AdminListResponse = z.object({
  schemaVersion: z.literal('1.0'),
  requests: z.array(VerificationRequestItem),
});

const AdminReviewResponse = z.object({
  schemaVersion: z.literal('1.0'),
  request: VerificationRequestItem,
});

type VerificationRequest = z.infer<typeof VerificationRequestItem>;

export interface AdminPageProps {
  user: User | null;
  onNavigate: (
    route: 'home' | 'signin' | 'create-account' | 'admin' | 'profile',
  ) => void;
}

export function AdminPage({ user, onNavigate }: AdminPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [requests, setRequests] = useState<VerificationRequest[]>([]);
  const [actionUid, setActionUid] = useState<string | null>(null);

  const isSoleAdmin =
    Boolean(user) &&
    user?.email?.toLowerCase() === ADMIN_EMAIL &&
    user?.emailVerified !== false;

  const loadRequests = useCallback(async () => {
    if (!user || !isSoleAdmin) return;
    setLoading(true);
    setError('');
    try {
      const api = new AuditApi(user);
      const data = await api.get(
        '/admin/verification-requests',
        AdminListResponse,
      );
      setRequests(data.requests);
    } catch (reason) {
      setError(
        reason instanceof RequestFailure
          ? reason.message
          : 'Failed to load verification requests.',
      );
    } finally {
      setLoading(false);
    }
  }, [user, isSoleAdmin]);

  useEffect(() => {
    if (isSoleAdmin) {
      void loadRequests();
    }
  }, [isSoleAdmin, loadRequests]);

  const handleGoogleAdminLogin = async () => {
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await signIn();
    } catch (reason) {
      setError(signInErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const handleEmailAdminLogin = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !email.trim() || !password) return;
    setPending(true);
    setError('');
    try {
      await signInWithEmail(email.trim(), password);
    } catch (reason) {
      setError(signInErrorMessage(reason));
    } finally {
      setPending(false);
    }
  };

  const handleDecision = async (
    uid: string,
    decision: 'approve' | 'reject',
  ) => {
    if (!user || actionUid) return;
    setActionUid(uid);
    setError('');
    try {
      const api = new AuditApi(user);
      const res = await api.mutate(
        `/admin/verification-requests/${encodeURIComponent(uid)}/${decision}`,
        'POST',
        {},
        AdminReviewResponse,
      );
      setRequests((prev) =>
        prev.map((item) => (item.uid === uid ? res.request : item)),
      );
    } catch (reason) {
      setError(
        reason instanceof RequestFailure
          ? reason.message
          : `Could not ${decision} request.`,
      );
    } finally {
      setActionUid(null);
    }
  };

  if (!isSoleAdmin) {
    return (
      <div className="split-auth-shell">
        <AuthBrandPanel />
        <main className="split-auth-right" aria-labelledby="admin-login-title">
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
              <a
                href="/signin"
                onClick={(event) => {
                  event.preventDefault();
                  onNavigate('signin');
                }}
              >
                User Sign in ↗
              </a>
            </div>
          </div>

          <div className="split-auth-form-wrap">
            <p className="split-auth-eyebrow">RESTRICTED ACCESS</p>
            <h1 id="admin-login-title" className="split-auth-title">
              Admin Login.
            </h1>
            <p className="split-auth-subtitle">
              Authorized administrator sign-in is required to review and approve
              account verification requests.
            </p>

            {user && user.email?.toLowerCase() !== ADMIN_EMAIL && (
              <div className="split-auth-error" role="alert">
                Access denied. Your current account does not have administrator
                privileges.
                <div style={{ marginTop: '0.65rem' }}>
                  <button
                    type="button"
                    className="split-auth-secondary-btn"
                    onClick={() => {
                      if (auth) void signOut(auth);
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            )}

            {error && (
              <div className="split-auth-error" role="alert">
                {error}
              </div>
            )}

            <div className="split-auth-form">
              <button
                type="button"
                className="split-auth-google-btn"
                disabled={!auth || pending}
                onClick={() => void handleGoogleAdminLogin()}
              >
                <GoogleIcon />
                <span>
                  {pending ? 'Opening sign-in…' : 'Sign in with Google'}
                </span>
              </button>

              <div className="split-auth-divider">
                <span>or continue with email</span>
              </div>

              <form
                className="split-auth-form"
                onSubmit={(e) => void handleEmailAdminLogin(e)}
              >
                <label className="split-auth-field">
                  <span>Admin email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="Administrator email"
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
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Enter admin password"
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
                  disabled={!auth || !email.trim() || !password || pending}
                >
                  Sign in as Admin
                </button>
              </form>
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <section className="admin-page" aria-labelledby="admin-dashboard-title">
      <div className="content-width">
        <div className="admin-header">
          <div>
            <p className="eyebrow">Administrator · {ADMIN_EMAIL}</p>
            <h1 id="admin-dashboard-title">Account Verification Requests</h1>
          </div>
          <div className="admin-actions">
            <button
              type="button"
              className="secondary-button"
              disabled={loading}
              onClick={() => void loadRequests()}
            >
              {loading ? 'Refreshing…' : 'Refresh'}
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => onNavigate('home')}
            >
              Back to Siphon
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                if (auth) void signOut(auth);
              }}
            >
              Sign out
            </button>
          </div>
        </div>

        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}

        {loading && requests.length === 0 ? (
          <p className="workspace-gate" role="status">
            Loading verification requests…
          </p>
        ) : requests.length === 0 ? (
          <div className="panel">
            <h3>No verification requests yet</h3>
            <p>
              When users submit an account verification request, it will appear
              here for approval.
            </p>
          </div>
        ) : (
          <div className="admin-request-list">
            {requests.map((item) => (
              <article key={item.uid} className="panel admin-request-card">
                <div className="admin-request-main">
                  <div className="admin-request-meta">
                    <span className={`status-pill status-${item.status}`}>
                      {item.status}
                    </span>
                    <span className="email-pill">
                      {item.emailVerified
                        ? 'Email verified'
                        : 'Email unverified'}
                    </span>
                  </div>
                  <h3>{item.name}</h3>
                  <p className="admin-request-detail">
                    <strong>Email:</strong> {item.email}
                  </p>
                  <p className="admin-request-detail">
                    <strong>Phone:</strong> {item.phone}
                  </p>
                  <small>
                    Submitted: {new Date(item.createdAt).toLocaleString()}
                    {item.reviewedAt
                      ? ` · Reviewed: ${new Date(item.reviewedAt).toLocaleString()}`
                      : ''}
                  </small>
                </div>
                <div className="admin-request-buttons">
                  <button
                    type="button"
                    className="primary-button"
                    disabled={
                      item.status === 'approved' || actionUid === item.uid
                    }
                    onClick={() => void handleDecision(item.uid, 'approve')}
                  >
                    {actionUid === item.uid
                      ? 'Saving…'
                      : item.status === 'approved'
                        ? 'Approved'
                        : 'Approve'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={
                      item.status === 'rejected' || actionUid === item.uid
                    }
                    onClick={() => void handleDecision(item.uid, 'reject')}
                  >
                    {item.status === 'rejected' ? 'Rejected' : 'Reject'}
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
