import { initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  browserPopupRedirectResolver,
  createUserWithEmailAndPassword,
  initializeAuth,
  GoogleAuthProvider,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  updatePassword,
  updateProfile,
  type User,
} from 'firebase/auth';

const configuration = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};
export const auth = Object.values(configuration).every(Boolean)
  ? initializeAuth(initializeApp(configuration), {
      persistence: browserSessionPersistence,
      popupRedirectResolver: browserPopupRedirectResolver,
    })
  : null;

export async function signIn(): Promise<void> {
  if (!auth)
    throw new Error(
      'Firebase sign-in is not configured. The operator must supply the public web configuration.',
    );
  await signInWithPopup(auth, new GoogleAuthProvider());
}

export async function signInWithEmail(
  email: string,
  password: string,
): Promise<User> {
  if (!auth)
    throw new Error(
      'Firebase sign-in is not configured. The operator must supply the public web configuration.',
    );
  const credential = await signInWithEmailAndPassword(auth, email, password);
  await credential.user.reload();
  return credential.user;
}

export async function createAccountAndSendVerification(
  name: string,
  email: string,
  password: string,
): Promise<User> {
  if (!auth)
    throw new Error(
      'Firebase sign-in is not configured. The operator must supply the public web configuration.',
    );
  const credential = await createUserWithEmailAndPassword(
    auth,
    email,
    password,
  );
  await updateProfile(credential.user, { displayName: name });
  await sendEmailVerification(credential.user);
  return credential.user;
}

export async function resendVerificationEmail(user: User): Promise<void> {
  await sendEmailVerification(user);
}

export async function changeUserPassword(
  user: User,
  newPassword: string,
): Promise<void> {
  await updatePassword(user, newPassword);
}

export async function sendResetPassword(email: string): Promise<void> {
  if (!auth)
    throw new Error(
      'Firebase sign-in is not configured. The operator must supply the public web configuration.',
    );
  await sendPasswordResetEmail(auth, email);
}

/** Display safe, actionable errors without exposing raw provider responses. */
export function signInErrorMessage(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : '';
  switch (code) {
    case 'auth/unauthorized-domain':
      return 'This website address is not authorized in Firebase. Ask the operator to add the current hostname under Authentication → Settings → Authorized domains, then try again.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method is not enabled for this Firebase project. Enable Google and Email/Password under Authentication → Sign-in method.';
    case 'auth/popup-blocked':
      return 'The browser blocked the sign-in window. Allow popups for this site and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'The sign-in window was closed before sign-in finished. Please try again.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Invalid email or password. Check your credentials and try again.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/email-already-in-use':
      return 'An account with this email address already exists. Please sign in instead.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 6 characters.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Firebase could not be reached. Check your internet connection and try again.';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid':
      return 'The Firebase web API key is invalid. Ask the operator to check the web app configuration and redeploy the site.';
    case 'auth/web-storage-unsupported':
      return 'The browser is blocking storage needed for sign-in. Allow site storage and try again.';
    default:
      return `Sign-in could not finish${/^auth\/[a-z0-9-]+$/.test(code) ? ` (${code})` : ''}. Check the Firebase sign-in settings and try again.`;
  }
}
