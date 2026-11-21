import { initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  browserPopupRedirectResolver,
  initializeAuth,
  GoogleAuthProvider,
  signInWithPopup,
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
      return 'Google sign-in is not enabled for this Firebase project. Enable Google under Authentication → Sign-in method.';
    case 'auth/popup-blocked':
      return 'The browser blocked the sign-in window. Allow popups for this site and try again.';
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'The sign-in window was closed before sign-in finished. Please try again.';
    case 'auth/network-request-failed':
      return 'Firebase could not be reached. Check your internet connection and try again.';
    case 'auth/invalid-api-key':
    case 'auth/api-key-not-valid':
      return 'The Firebase web API key is invalid. Ask the operator to check the web app configuration and redeploy the site.';
    case 'auth/web-storage-unsupported':
      return 'The browser is blocking storage needed for sign-in. Allow site storage and try again.';
    default:
      return `Google sign-in could not finish${/^auth\/[a-z0-9-]+$/.test(code) ? ` (${code})` : ''}. Check the Firebase sign-in settings and try again.`;
  }
}
