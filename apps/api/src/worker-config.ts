import { z } from 'zod';
import { FirebaseServiceConfiguration } from './firebase-config.js';

const origin = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      const url = new URL(value);
      if (
        url.origin !== value ||
        url.username ||
        url.password ||
        (url.protocol !== 'https:' &&
          !(
            url.protocol === 'http:' &&
            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
          ))
      )
        ctx.addIssue({
          code: 'custom',
          message:
            'Expected an exact HTTPS origin or loopback development origin',
        });
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Invalid origin' });
    }
  });

export const WorkerConfiguration = FirebaseServiceConfiguration.safeExtend({
  SIPHON_ALLOWED_ORIGINS: z
    .string()
    .max(16384)
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({
          code: 'custom',
          message: 'Expected JSON origin list',
        });
        return z.NEVER;
      }
    })
    .pipe(
      z
        .array(origin)
        .min(1)
        .max(10)
        .refine((values) => new Set(values).size === values.length),
    ),
});

export type WorkerConfiguration = z.infer<typeof WorkerConfiguration>;
