import { describe, expect, it } from 'vitest';
import { FirebaseServiceConfiguration } from './firebase-config.js';

const firebase = {
  FIREBASE_PROJECT_ID: 'siphon-test',
  GOOGLE_SERVICE_ACCOUNT_EMAIL: 'service@siphon-test.iam.gserviceaccount.com',
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:
    '-----BEGIN PRIVATE KEY-----\nYXV0aG9yZWQ=\n-----END PRIVATE KEY-----\n',
};

describe('Firebase service configuration', () => {
  it('supports an explicit named database and documents the compatible default', () => {
    expect(
      FirebaseServiceConfiguration.parse({
        ...firebase,
        FIRESTORE_DATABASE_ID: 'private-audits',
      }).FIRESTORE_DATABASE_ID,
    ).toBe('private-audits');
    expect(
      FirebaseServiceConfiguration.parse(firebase).FIRESTORE_DATABASE_ID,
    ).toBe('(default)');
  });

  it('rejects path injection and mismatched service-account projects', () => {
    expect(
      FirebaseServiceConfiguration.safeParse({
        ...firebase,
        FIRESTORE_DATABASE_ID: '(default)/documents/other',
      }).success,
    ).toBe(false);
    expect(
      FirebaseServiceConfiguration.safeParse({
        ...firebase,
        GOOGLE_SERVICE_ACCOUNT_EMAIL:
          'service@other-project.iam.gserviceaccount.com',
      }).success,
    ).toBe(false);
  });
});
