import { describe, expect, it } from 'vitest';
import { signInErrorMessage } from './auth.js';

describe('sign-in diagnostics', () => {
  it('gives an actionable message for an unauthorized domain', () => {
    const message = signInErrorMessage({ code: 'auth/unauthorized-domain' });
    expect(message).toContain('current hostname');
    expect(message).not.toContain('localhost:5173');
  });

  it('distinguishes disabled Google sign-in and a blocked popup', () => {
    expect(
      signInErrorMessage({ code: 'auth/operation-not-allowed' }),
    ).toContain('Enable Google');
    expect(signInErrorMessage({ code: 'auth/popup-blocked' })).toContain(
      'Allow popups',
    );
  });

  it('does not expose arbitrary provider error text', () => {
    expect(
      signInErrorMessage({ code: 'secret', message: 'private value' }),
    ).not.toContain('private value');
  });
});
