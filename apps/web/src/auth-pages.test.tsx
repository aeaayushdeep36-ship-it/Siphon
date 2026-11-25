// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  user: null as {
    uid?: string;
    email?: string | null;
    emailVerified?: boolean;
    displayName?: string | null;
    getIdToken: () => Promise<string>;
  } | null,
}));

vi.mock('./auth.js', () => ({
  auth: {},
  signIn: vi.fn(async () => {}),
  signInWithEmail: vi.fn(async () => state.user),
  createAccountAndSendVerification: vi.fn(async () => state.user),
  resendVerificationEmail: vi.fn(async () => {}),
  signInErrorMessage: () => 'Authentication failed',
}));

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, notify: (user: unknown) => void) => {
    notify(state.user);
    return () => {};
  },
  signOut: vi.fn(async () => {}),
}));

import { App } from './App.js';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderApp() {
  window.matchMedia = vi.fn().mockReturnValue({
    matches: true,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as typeof window.matchMedia;
  window.scrollTo = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<App />);
  });
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  return host;
}

async function flushLazy() {
  await act(async () => {
    await vi.dynamicImportSettled();
  });
}

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  host?.remove();
  host = null;
  state.user = null;
  window.history.replaceState(null, '', '/');
  vi.unstubAllGlobals();
});

describe('Sign-in, Create Account, and Admin pages', () => {
  it('omits Admin on landing page, navigates to /signin and back via browser popstate, places Create account & Admin in top-right, and enforces Verify Account validation', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = await renderApp();

    // 1. Landing page has Sign in (not Continue with Google), NO Simulation audit console badge, and NO Admin link
    expect(container.textContent).not.toContain('Continue with Google');
    expect(container.textContent).not.toContain('Simulation audit console');
    expect(container.textContent).toContain('Create and review your simulation audits');
    expect(container.querySelector('header a[href="/admin"], header a[href="#admin"]')).toBeNull();
    const signInBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes('Sign in'),
    );
    expect(signInBtn).toBeTruthy();

    // 2. Clicking Sign in navigates to /signin via pushState
    await act(async () => {
      signInBtn!.click();
    });
    await flushLazy();
    expect(window.location.pathname).toBe('/signin');
    expect(container.textContent).toContain('Sign in to Siphon.');
    expect(container.textContent).toContain('Back to Siphon');
    expect(container.textContent).toContain('Sign in with Google');
    expect(container.querySelector('.google-g-icon')).toBeTruthy();

    // Top-right of Sign-in page has Create account and Admin links
    const createAccountLink = container.querySelector(
      '.split-auth-toplinks a[href="/create-account"]',
    ) as HTMLAnchorElement;
    const adminLink = container.querySelector(
      '.split-auth-toplinks a[href="/admin"]',
    ) as HTMLAnchorElement;
    expect(createAccountLink?.textContent).toContain('Create account');
    expect(adminLink?.textContent).toContain('Admin');

    // 3. Browser Back button (popstate to /) returns to homepage
    await act(async () => {
      window.history.replaceState(null, '', '/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(container.textContent).toContain('Evidence for your simulation.');
    expect(container.querySelector('header')).toBeTruthy();

    // Go back to /signin then click Create account -> /create-account
    await act(async () => {
      const btn = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Sign in'),
      );
      btn!.click();
    });
    await act(async () => {
      const link = container.querySelector(
        '.split-auth-toplinks a[href="/create-account"]',
      ) as HTMLAnchorElement;
      link.click();
    });
    expect(window.location.pathname).toBe('/create-account');

    const verifyBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Verify Account',
    ) as HTMLButtonElement;
    expect(verifyBtn).toBeTruthy();
    expect(verifyBtn.disabled).toBe(true);

    const inputs = Array.from(container.querySelectorAll('form input')) as HTMLInputElement[];
    const [nameInput, emailInput, phoneInput, passInput, confirmInput] = inputs;

    const setVal = async (el: HTMLInputElement, val: string) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };

    await setVal(nameInput!, 'Alice Researcher');
    await setVal(emailInput!, 'alice@example.com');
    await setVal(phoneInput!, '+1 555 010 9999');
    await setVal(passInput!, 'secret123');
    expect(verifyBtn.disabled).toBe(true);

    await setVal(confirmInput!, 'different');
    expect(verifyBtn.disabled).toBe(true);

    await setVal(confirmInput!, 'secret123');
    expect(verifyBtn.disabled).toBe(false);

    // 4. Clicking Admin link navigates to /admin without pre-filling or exposing admin email
    await act(async () => {
      const link = container.querySelector(
        '.split-auth-toplinks a[href="/admin"]',
      ) as HTMLAnchorElement;
      link.click();
    });
    await flushLazy();
    expect(window.location.pathname).toBe('/admin');
    expect(container.textContent).toContain('Admin Login.');
    expect(container.textContent).toContain('Sign in with Google');
    expect(container.querySelector('.google-g-icon')).toBeTruthy();
    expect(container.textContent).not.toContain('aeaayushdeep36@gmail.com');
    const adminEmailInput = container.querySelector('input[type="email"]') as HTMLInputElement;
    expect(adminEmailInput?.value).toBe('');
  });

  it('denies non-admin user on Admin page and loads requests for aeaayushdeep36@gmail.com', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.user = {
      uid: 'other',
      email: 'someone@example.com',
      emailVerified: true,
      getIdToken: async () => 'token',
    };
    window.history.replaceState(null, '', '/admin');
    let container = await renderApp();
    expect(container.textContent).toContain('Access denied.');
    expect(container.textContent).not.toContain('aeaayushdeep36@gmail.com');
    await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;

    state.user = {
      uid: 'admin-uid',
      email: 'aeaayushdeep36@gmail.com',
      emailVerified: true,
      getIdToken: async () => 'admin-token',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            schemaVersion: '1.0',
            requests: [
              {
                schemaVersion: '1.0',
                uid: 'u1',
                email: 'applicant@example.com',
                name: 'Applicant One',
                phone: '+1 555 010 1111',
                emailVerified: true,
                status: 'pending',
                createdAt: '2026-11-25T00:00:00.000Z',
                updatedAt: '2026-11-25T00:00:00.000Z',
                reviewedBy: null,
                reviewedAt: null,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );
    window.history.replaceState(null, '', '/admin');
    container = await renderApp();
    expect(container.textContent).toContain('Account Verification Requests');
    expect(container.textContent).toContain('Applicant One');
    expect(container.textContent).toContain('applicant@example.com');
    expect(container.textContent).toContain('Approve');
  });

  it('shows profile button with photo and first name, dropdown with View profile and red Sign out, and Profile page with General and Your works tabs', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.user = {
      uid: 'u-prof',
      email: 'aayush@example.com',
      emailVerified: true,
      displayName: 'Aayush Deep',
      photoURL: 'https://example.com/photo.jpg',
      getIdToken: async () => 'token',
    } as typeof state.user & { photoURL?: string };

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/auth/verification-status')) {
          return new Response(
            JSON.stringify({
              schemaVersion: '1.0',
              status: 'approved',
              emailVerified: true,
              isAdmin: false,
              request: {
                name: 'Aayush Deep',
                phone: '+91 99999 00000',
                email: 'aayush@example.com',
              },
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            schemaVersion: '1.0',
            audits: [
              {
                schemaVersion: '1.0',
                id: '11111111-1111-4111-8111-111111111111',
                ownerUid: 'u-prof',
                title: 'Copper Plate Diffusion',
                domain: 'heat_diffusion',
                currentRevisionId: '22222222-2222-4222-8222-222222222222',
                createdAt: '2026-11-24T12:00:00.000Z',
                updatedAt: '2026-11-24T12:00:00.000Z',
                deletionRequestedAt: null,
              },
            ],
            nextCursor: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }),
    );

    const container = await renderApp();
    const trigger = container.querySelector('.profile-trigger') as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain('Aayush');
    expect(trigger.textContent).not.toContain('Deep');
    expect(
      (container.querySelector('.profile-avatar') as HTMLImageElement)?.src,
    ).toBe('https://example.com/photo.jpg');

    await act(async () => {
      trigger.click();
    });
    const viewProfileBtn = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (b) => b.textContent?.includes('View profile'),
    ) as HTMLButtonElement;
    const signOutBtn = container.querySelector('.profile-dropdown-signout') as HTMLButtonElement;
    expect(viewProfileBtn).toBeTruthy();
    expect(signOutBtn?.textContent).toBe('Sign out');

    await act(async () => {
      viewProfileBtn.click();
    });
    await flushLazy();
    expect(window.location.pathname).toBe('/profile');
    expect(container.textContent).toContain('General');
    expect(container.textContent).toContain('Your works');
    expect(container.textContent).toContain('Change password');
    expect(container.textContent).toContain('+91 99999 00000');

    const worksTab = Array.from(container.querySelectorAll('[role="tab"]')).find(
      (b) => b.textContent?.trim() === 'Your works',
    ) as HTMLButtonElement;
    await act(async () => {
      worksTab.click();
    });
    expect(container.textContent).toContain('Copper Plate Diffusion');
  });
});
