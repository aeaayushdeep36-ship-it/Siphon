import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  session: { name: 'session' },
  resolver: { name: 'popup-resolver' },
  auth: { name: 'auth' },
  initializeAuth: vi.fn(),
  signInWithPopup: vi.fn(),
}));

vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock('firebase/auth', () => ({
  browserSessionPersistence: fixture.session,
  browserPopupRedirectResolver: fixture.resolver,
  initializeAuth: fixture.initializeAuth,
  GoogleAuthProvider: class {},
  signInWithPopup: fixture.signInWithPopup,
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.clearAllMocks();
});

describe('Google sign-in initialization', () => {
  it('configures session persistence before the click and starts the popup immediately', async () => {
    for (const key of [
      'VITE_FIREBASE_API_KEY',
      'VITE_FIREBASE_AUTH_DOMAIN',
      'VITE_FIREBASE_PROJECT_ID',
      'VITE_FIREBASE_APP_ID',
    ])
      vi.stubEnv(key, 'fixture');
    fixture.initializeAuth.mockReturnValue(fixture.auth);
    fixture.signInWithPopup.mockResolvedValue({});
    const { signIn } = await import('./auth.js');
    expect(fixture.initializeAuth).toHaveBeenCalledWith(expect.anything(), {
      persistence: fixture.session,
      popupRedirectResolver: fixture.resolver,
    });
    const result = signIn();
    expect(fixture.signInWithPopup).toHaveBeenCalledOnce();
    await result;
  });
});
