import { initializeApp } from 'firebase/app';
import {
  browserSessionPersistence,
  getAuth,
  GoogleAuthProvider,
  setPersistence,
  signInWithPopup,
} from 'firebase/auth';

const configuration = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};
export const auth = Object.values(configuration).every(Boolean)
  ? getAuth(initializeApp(configuration))
  : null;
export async function signIn(): Promise<void> {
  if (!auth)
    throw new Error(
      'Firebase sign-in is not configured. The operator must supply the public web configuration.',
    );
  await setPersistence(auth, browserSessionPersistence);
  await signInWithPopup(auth, new GoogleAuthProvider());
}
