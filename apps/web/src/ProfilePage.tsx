import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { signOut, type User } from 'firebase/auth';
import { z } from 'zod';
import { AuditHistoryResponse, type Audit } from '@siphon/contracts';
import { AuditApi, RequestFailure } from './api.js';
import {
  auth,
  changeUserPassword,
  sendResetPassword,
  signInErrorMessage,
} from './auth.js';

const ProfileStatusResponse = z.object({
  schemaVersion: z.literal('1.0'),
  status: z.enum(['approved', 'pending', 'rejected', 'unregistered']),
  emailVerified: z.boolean(),
  isAdmin: z.boolean(),
  request: z
    .object({
      name: z.string(),
      phone: z.string(),
      email: z.string(),
    })
    .nullable()
    .optional(),
});

type ProfileStatus = z.infer<typeof ProfileStatusResponse>;
type AuditItem = z.infer<typeof Audit>;

export interface ProfilePageProps {
  user: User;
  onNavigate: (
    route: 'home' | 'signin' | 'create-account' | 'admin' | 'profile',
  ) => void;
  onOpenAudit?: (auditId: string) => void;
}

export function ProfilePage({
  user,
  onNavigate,
  onOpenAudit,
}: ProfilePageProps) {
  const [tab, setTab] = useState<'general' | 'works'>('general');
  const [profileData, setProfileData] = useState<ProfileStatus | null>(null);
  const [works, setWorks] = useState<AuditItem[]>([]);
  const [worksLoading, setWorksLoading] = useState(false);
  const [worksError, setWorksError] = useState('');

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwPending, setPwPending] = useState(false);
  const [pwError, setPwError] = useState('');
  const [pwNotice, setPwNotice] = useState('');

  const displayName =
    profileData?.request?.name ||
    user.displayName ||
    user.email?.split('@')[0] ||
    'Siphon User';
  const email = profileData?.request?.email || user.email || 'Not provided';
  const phone =
    profileData?.request?.phone || user.phoneNumber || 'Not provided';

  const loadProfile = useCallback(async () => {
    try {
      const api = new AuditApi(user);
      const data = await api.get(
        '/auth/verification-status',
        ProfileStatusResponse,
      );
      setProfileData(data);
    } catch {
      // Fall back to Firebase user metadata if backend profile lookup fails.
    }
  }, [user]);

  const loadWorks = useCallback(async () => {
    setWorksLoading(true);
    setWorksError('');
    try {
      const api = new AuditApi(user);
      const res = await api.get('/audits', AuditHistoryResponse);
      setWorks(res.audits);
    } catch (reason) {
      setWorksError(
        reason instanceof RequestFailure
          ? reason.message
          : 'Could not load your past works.',
      );
    } finally {
      setWorksLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (tab === 'works') {
      void loadWorks();
    }
  }, [tab, loadWorks]);

  const isPasswordValid =
    newPassword.length >= 6 &&
    confirmPassword.length > 0 &&
    newPassword === confirmPassword;

  const handleChangePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!isPasswordValid || pwPending) return;
    setPwPending(true);
    setPwError('');
    setPwNotice('');
    try {
      await changeUserPassword(user, newPassword);
      setNewPassword('');
      setConfirmPassword('');
      setPwNotice('Password updated successfully.');
    } catch (reason) {
      const code =
        typeof reason === 'object' && reason !== null && 'code' in reason
          ? String(reason.code)
          : '';
      if (code === 'auth/requires-recent-login') {
        setPwError(
          'For security, please use "Send password reset email" below or sign in again before changing your password.',
        );
      } else {
        setPwError(signInErrorMessage(reason));
      }
    } finally {
      setPwPending(false);
    }
  };

  const handleSendResetEmail = async () => {
    if (!user.email || pwPending) return;
    setPwPending(true);
    setPwError('');
    setPwNotice('');
    try {
      await sendResetPassword(user.email);
      setPwNotice(`Password reset email sent to ${user.email}.`);
    } catch (reason) {
      setPwError(signInErrorMessage(reason));
    } finally {
      setPwPending(false);
    }
  };

  return (
    <div className="profile-page-shell">
      <header className="profile-topbar">
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
        <div className="profile-tabs" role="tablist" aria-label="Profile sections">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'general'}
            className={tab === 'general' ? 'primary-button' : 'secondary-button'}
            onClick={() => setTab('general')}
          >
            General
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'works'}
            className={tab === 'works' ? 'primary-button' : 'secondary-button'}
            onClick={() => setTab('works')}
          >
            Your works
          </button>
        </div>
        <button
          type="button"
          className="profile-signout-btn"
          onClick={() => {
            if (auth) {
              void signOut(auth).then(() => onNavigate('home'));
            }
          }}
        >
          Sign out
        </button>
      </header>

      <main className="profile-main">
        {tab === 'general' ? (
          <div className="profile-grid">
            <section className="panel profile-card">
              <div className="profile-identity-head">
                {user.photoURL ? (
                  <img
                    src={user.photoURL}
                    alt={displayName}
                    className="profile-avatar-lg"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <span className="profile-avatar-fallback-lg" aria-hidden="true">
                    {displayName.charAt(0).toUpperCase()}
                  </span>
                )}
                <div>
                  <p className="eyebrow">General profile</p>
                  <h1>{displayName}</h1>
                  <p className="muted">
                    {user.emailVerified ? 'Verified account' : 'Email verification pending'}
                  </p>
                </div>
              </div>

              <dl className="profile-details-list">
                <div>
                  <dt>Name</dt>
                  <dd>{displayName}</dd>
                </div>
                <div>
                  <dt>Email</dt>
                  <dd>{email}</dd>
                </div>
                <div>
                  <dt>Phone number</dt>
                  <dd>{phone}</dd>
                </div>
                <div>
                  <dt>Account status</dt>
                  <dd>{profileData?.status ?? 'active'}</dd>
                </div>
              </dl>
            </section>

            <section className="panel profile-card">
              <p className="eyebrow">Security</p>
              <h2>Change password</h2>
              <p className="muted">
                Update your account password or send a password reset link to{' '}
                {email}.
              </p>

              {pwError && (
                <div className="split-auth-error" role="alert">
                  {pwError}
                </div>
              )}
              {pwNotice && (
                <div className="split-auth-notice" role="status">
                  {pwNotice}
                </div>
              )}

              <form
                className="split-auth-form"
                onSubmit={(e) => void handleChangePassword(e)}
              >
                <label className="split-auth-field">
                  <span>New password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="At least 6 characters"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </label>
                <label className="split-auth-field">
                  <span>Re-enter new password</span>
                  <input
                    type="password"
                    autoComplete="new-password"
                    placeholder="Re-enter new password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                </label>
                {confirmPassword.length > 0 && newPassword !== confirmPassword && (
                  <small className="split-auth-hint-error">
                    Passwords do not match.
                  </small>
                )}
                <div className="actions">
                  <button
                    type="submit"
                    className="primary-button"
                    disabled={!isPasswordValid || pwPending}
                  >
                    {pwPending ? 'Updating…' : 'Change password'}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={!user.email || pwPending}
                    onClick={() => void handleSendResetEmail()}
                  >
                    Send password reset email
                  </button>
                </div>
              </form>
            </section>
          </div>
        ) : (
          <section className="panel profile-works-panel">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Saved projects</p>
                <h1>Your works</h1>
              </div>
              <button
                type="button"
                className="secondary-button"
                disabled={worksLoading}
                onClick={() => void loadWorks()}
              >
                {worksLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            {worksError && (
              <div className="error" role="alert">
                {worksError}
              </div>
            )}

            {worksLoading && works.length === 0 ? (
              <p className="muted" role="status">
                Loading your saved simulation audits…
              </p>
            ) : works.length === 0 ? (
              <div className="profile-empty-works">
                <h3>No saved works yet</h3>
                <p>
                  Once you create and run a simulation audit, your projects will
                  be saved here.
                </p>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => onNavigate('home')}
                >
                  Start an audit
                </button>
              </div>
            ) : (
              <div className="profile-works-list">
                {works.map((item) => (
                  <article key={item.id} className="profile-work-card">
                    <div>
                      <span className="email-pill">
                        {item.domain === 'heat_diffusion'
                          ? 'Heat Diffusion'
                          : 'Orbital Dynamics'}
                      </span>
                      <h3>{item.title}</h3>
                      <small>
                        Created: {new Date(item.createdAt).toLocaleString()}
                      </small>
                    </div>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        onOpenAudit?.(item.id);
                        onNavigate('home');
                      }}
                    >
                      Open in workspace ↗
                    </button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}
