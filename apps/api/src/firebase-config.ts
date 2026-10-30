import { z } from 'zod';

/** Server-only credential envelope shared by API and Workflow compositions. */
export const FirebaseServiceConfiguration = z
  .object({
    FIREBASE_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
    GOOGLE_SERVICE_ACCOUNT_EMAIL: z.email(),
    GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: z
      .string()
      .max(16384)
      .regex(
        /^-----BEGIN PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PRIVATE KEY-----\r?\n?$/,
      ),
  })
  .superRefine((value, ctx) => {
    if (
      !value.GOOGLE_SERVICE_ACCOUNT_EMAIL.endsWith(
        `@${value.FIREBASE_PROJECT_ID}.iam.gserviceaccount.com`,
      )
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Service account must belong to the configured project',
      });
  });
