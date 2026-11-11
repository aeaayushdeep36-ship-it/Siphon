import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { z } from 'zod';
import type Lenis from 'lenis';
import {
  Audit,
  AuditWorkspace,
  AuditHistoryResponse,
  Digest,
  Domain,
  EvidenceReportResponse,
  InvestigationReviewReceipt,
  ProgressSnapshot,
  QuestionSet,
  AiDisclosureReceipt,
  QueuedAuditReceipt,
  ResumedAuditReceipt,
  RevisionReceipt,
  UploadReservation,
  preflightUploads,
  DEFAULT_POLICY,
  RevisionHistoryResponse,
} from '@siphon/contracts';
import { AuditApi, digestBytes, RequestFailure } from './api.js';
import { auth, signIn, signInErrorMessage } from './auth.js';
import { label } from './labels.js';
import { ReportBoundary } from './ReportBoundary.js';
import { startReadPolling } from './read-polling.js';
import { InvestigationReview } from './InvestigationReview.js';
import { AiDisclosurePanel } from './AiDisclosurePanel.js';

const Report = lazy(() =>
  import('./Report.js').then((module) => ({ default: module.Report })),
);

export function resumeNeedsAiDisclosure(
  workspace: Pick<AuditWorkspace, 'stage' | 'investigation'>,
) {
  // Saved investigation and report stages resume without another AI dispatch.
  return workspace.stage !== 'reporting' && workspace.investigation === null;
}

const AuditResponse = z.object({
  schemaVersion: z.literal('1.0'),
  audit: Audit,
});
const Workspace = AuditWorkspace;
const RevisionsResponse = RevisionHistoryResponse;
const QuestionsResponse = z.object({
  questionSet: QuestionSet,
  questionSetDigest: Digest,
});
const CommandReceipt = z.object({ cleanup: z.enum(['confirmed', 'pending']) });
type Workspace = z.infer<typeof Workspace>;
type Questions = z.infer<typeof QuestionsResponse>;
type ResponseReport = z.infer<typeof EvidenceReportResponse>;
type DomainValue = z.infer<typeof Domain>;

const domainDetails: Record<
  DomainValue,
  { title: string; scope: string; detail: string; checks: string[] }
> = {
  heat_diffusion: {
    title: 'Heat',
    scope: 'Heat diffusion',
    detail:
      'Transient 1D/2D diffusion on a uniform Cartesian grid with constant material properties.',
    checks: ['Energy balance', 'Geometry and units', 'Boundary assumptions'],
  },
  orbital_dynamics: {
    title: 'Gravitation',
    scope: 'Orbital dynamics',
    detail:
      'Newtonian point masses in an isolated system or a fixed central field.',
    checks: ['Energy', 'Angular momentum', 'Coordinate frame'],
  },
};

function errorText(error: unknown): string {
  if (error instanceof RequestFailure)
    return `${error.message} (${error.code}${error.requestId ? `; request ${error.requestId}` : ''})`;
  if (
    error instanceof Error &&
    [
      'Choose an option or enter a custom answer.',
      'Answer every mapping question',
    ].includes(error.message)
  )
    return error.message;
  return error instanceof Error && error.name === 'AbortError'
    ? ''
    : 'The request could not be completed. Check the connection and retry. Your simulation has not been changed.';
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!auth);
  const [signInPending, setSignInPending] = useState(false);
  const signInInProgress = useRef(false);
  const [error, setError] = useState('');
  const [selectedDomain, setSelectedDomain] = useState<DomainValue | ''>('');
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let scroller: Lenis | undefined;
    let animationFrame = 0;
    let generation = 0;
    const configure = () => {
      const currentGeneration = ++generation;
      cancelAnimationFrame(animationFrame);
      scroller?.destroy();
      scroller = undefined;
      if (preference.matches) return;
      void import('lenis')
        .then(({ default: SmoothScroller }) => {
          if (currentGeneration !== generation || preference.matches) return;
          scroller = new SmoothScroller({
            duration: 1.25,
            lerp: 0.08,
            smoothWheel: true,
          });
          const animate = (time: number) => {
            scroller?.raf(time);
            animationFrame = requestAnimationFrame(animate);
          };
          animationFrame = requestAnimationFrame(animate);
        })
        .catch(() => {
          // Native scrolling remains available if the optional chunk cannot load.
        });
    };
    configure();
    preference.addEventListener('change', configure);
    return () => {
      generation++;
      preference.removeEventListener('change', configure);
      cancelAnimationFrame(animationFrame);
      scroller?.destroy();
    };
  }, []);
  useEffect(
    () =>
      auth
        ? onAuthStateChanged(auth, (value) => {
            setUser(value);
            setAuthReady(true);
            setError('');
          })
        : undefined,
    [],
  );
  const continueWithGoogle = () => {
    if (signInInProgress.current) return;
    signInInProgress.current = true;
    setSignInPending(true);
    setError('');
    void signIn()
      .catch((reason: unknown) => setError(signInErrorMessage(reason)))
      .finally(() => {
        signInInProgress.current = false;
        setSignInPending(false);
      });
  };

  return (
    <div className="app-shell">
      <header className="site-header">
        <a href="#hero" className="brand" aria-label="Siphon home">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>
          <span className="brand-name">Siphon</span>
          <span className="brand-caption">Simulation audit console</span>
        </a>
        <nav className="top-nav" aria-label="Main navigation">
          <a href="#hero">Overview</a>
          <a href="#domains">Domains</a>
          <a href="#workspace">Workspace</a>
          <a href="#testplan">Test plan</a>
          <a href="#evidence">Evidence</a>
        </nav>
        <div className="header-actions">
          <details className="mobile-menu">
            <summary aria-label="Navigation menu">Menu</summary>
            <nav
              aria-label="Mobile navigation"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest('a'))
                  event.currentTarget.parentElement?.removeAttribute('open');
              }}
            >
              <a href="#hero">Overview</a>
              <a href="#domains">Domains</a>
              <a href="#workspace">Workspace</a>
              <a href="#testplan">Test plan</a>
              <a href="#evidence">Evidence</a>
            </nav>
          </details>
          {user ? (
            <>
              <span className="signed-in-label">
                {user.displayName ?? 'Signed in'}
              </span>
              <button
                className="header-button"
                onClick={() => {
                  if (auth)
                    void signOut(auth).catch(() =>
                      setError('Sign-out failed. Please retry.'),
                    );
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <button
              className="header-button primary-button"
              disabled={!auth || signInPending}
              onClick={continueWithGoogle}
            >
              {signInPending ? 'Opening sign-in…' : 'Continue with Google'}{' '}
              <span aria-hidden="true">↗</span>
            </button>
          )}
        </div>
      </header>
      <main id="main" className="page-content">
        {error && (
          <div className="error global-error" role="alert">
            {error}
          </div>
        )}
        <section className="hero" id="hero" aria-labelledby="hero-title">
          <div className="hero-art" aria-hidden="true" />
          <div className="hero-vignette" aria-hidden="true" />
          <div className="hero-center" aria-hidden="true">
            SIPHON
          </div>
          <div className="hero-copy">
            <p className="eyebrow hero-kicker">
              <span className="status-dot" /> Inspect · Measure · Understand
            </p>
            <h1 id="hero-title">Evidence for your simulation.</h1>
            <p className="hero-description">
              Review an existing Python heat-diffusion or orbital-dynamics
              model. Siphon is being built to show applicable checks, their
              evidence, and the assumptions and limits behind each result.
            </p>
            <p className="hero-access">
              Google sign-in and an active invitation are required for private
              audit history.
            </p>
            <div className="hero-actions">
              <a className="primary-button" href="#domains">
                Inspect physics domains <span aria-hidden="true">↓</span>
              </a>
              <a className="secondary-button" href="#workspace">
                {user ? 'Open audit workspace' : 'Workspace access'}{' '}
                <span aria-hidden="true">↗</span>
              </a>
            </div>
            {!auth && (
              <p className="hero-config-note" role="status">
                Sign-in unavailable until the operator configures Firebase
                public web settings.
              </p>
            )}
          </div>
          <a className="hero-scroll" href="#domains">
            Scroll to explore
          </a>
        </section>

        <section
          id="domains"
          className="domain-section"
          aria-labelledby="domain-heading"
        >
          <div className="content-width">
            <div className="domain-heading">
              <div>
                <p className="eyebrow">01 // Simulation domain · required</p>
                <h2 id="domain-heading">
                  Choose the physics. Bring your code.
                </h2>
              </div>
              <p>
                Selection narrows which reviewed checks can be considered.
                Assumptions and required observations must still be established.
              </p>
            </div>
            <div
              className="domain-grid"
              role="group"
              aria-label="Choose a simulation domain"
            >
              {(
                Object.entries(domainDetails) as [
                  DomainValue,
                  (typeof domainDetails)[DomainValue],
                ][]
              ).map(([key, item]) => (
                <article
                  className={`domain-card ${key === 'heat_diffusion' ? 'heat-card' : 'gravity-card'} ${selectedDomain === key ? 'is-selected' : ''}`}
                  key={key}
                >
                  <div className="domain-card-shade" aria-hidden="true" />
                  <div className="domain-card-head">
                    <span className="domain-chip">
                      <i className="status-dot" /> DOMAIN: {key}
                    </span>
                    <span className="domain-code">
                      {key === 'heat_diffusion'
                        ? 'HEAT DIFFUSION'
                        : 'ORBITAL DYNAMICS'}
                    </span>
                  </div>
                  <div className="domain-card-body">
                    <h3>{item.title}</h3>
                    <p>{item.detail}</p>
                    <div
                      className="domain-checks"
                      aria-label="Relevant context"
                    >
                      {item.checks.map((check) => (
                        <span key={check}>{check}</span>
                      ))}
                    </div>
                    <div className="domain-card-footer">
                      <span>{item.scope} · prerequisites apply</span>
                      <button
                        type="button"
                        className="select-domain"
                        aria-pressed={selectedDomain === key}
                        onClick={() => {
                          setSelectedDomain(key);
                          document.getElementById('workspace')?.scrollIntoView({
                            behavior: window.matchMedia(
                              '(prefers-reduced-motion: reduce)',
                            ).matches
                              ? 'instant'
                              : 'smooth',
                          });
                        }}
                      >
                        {selectedDomain === key
                          ? 'Selected'
                          : `Select ${item.title}`}{' '}
                        <span aria-hidden="true">↗</span>
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
            <p className="domain-status" aria-live="polite">
              {selectedDomain ? (
                <>
                  <strong>
                    {domainDetails[selectedDomain].title} selected.
                  </strong>{' '}
                  {user
                    ? 'Continue in the workspace to create a private audit.'
                    : 'Sign in with an active invitation to create a private audit.'}
                </>
              ) : (
                'Choose Heat or Gravitation. You can change this selection before creating an audit.'
              )}
            </p>
          </div>
        </section>

        <section
          id="workspace"
          className="workspace-section"
          aria-labelledby="workspace-heading"
        >
          <div className="content-width">
            <div className="workspace-intro">
              <p className="eyebrow">02 // Active audit workbench</p>
              <h2 id="workspace-heading">
                Console execution &amp; adapter review
              </h2>
            </div>
            {!authReady ? (
              <p className="workspace-gate" role="status">
                Checking sign-in…
              </p>
            ) : user ? (
              <Console
                key={user.uid}
                user={user}
                selectedDomain={selectedDomain}
                onSelectDomain={setSelectedDomain}
              />
            ) : (
              <section className="workspace-gate" id="workspace-access">
                <div>
                  <p className="eyebrow">Private workspace</p>
                  <h3>Sign in to view audit history or start a review.</h3>
                  <p>
                    Access requires Google sign-in and an active invitation.
                    This preview does not create demo audits or show sample
                    results as real data.
                  </p>
                </div>
                <button
                  className="primary-button"
                  disabled={!auth || signInPending}
                  onClick={continueWithGoogle}
                >
                  {signInPending ? 'Opening sign-in…' : 'Continue with Google'}{' '}
                  <span aria-hidden="true">↗</span>
                </button>
              </section>
            )}
            {!user && (
              <div className="workspace-placeholders">
                <section className="panel" id="testplan">
                  <p className="eyebrow">Deterministic test plan</p>
                  <h3>Checks depend on your simulation.</h3>
                  <p>
                    Sign in and select an audit to review its applicable checks,
                    exclusions, and assumptions.
                  </p>
                </section>
                <section className="panel" id="evidence">
                  <p className="eyebrow">Evidence report</p>
                  <h3>Results appear here when published.</h3>
                  <p>
                    Open an audit to see its recorded evidence and report
                    availability.
                  </p>
                </section>
              </div>
            )}
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <div className="footer-main">
          <a className="brand-name" href="#hero">
            Siphon
          </a>
          <p>Scientific simulation audit console</p>
          <nav aria-label="Footer navigation">
            <a href="#domains">Domains</a>
            <a href="#workspace">Workspace</a>
            <a href="#testplan">Test plan</a>
            <a href="#evidence">Evidence</a>
            <a
              href="https://github.com/aeaayushdeep36-ship-it/Siphon"
              target="_blank"
              rel="noreferrer"
            >
              GitHub
            </a>
          </nav>
        </div>
        <p className="footer-note">
          Siphon audits and recommends. Results apply to the recorded checks,
          assumptions and accuracy policies. They do not certify that a
          scientific model is correct.
        </p>
        <p className="footer-stack">
          Cloudflare Workers API · Firebase Auth &amp; Firestore · E2B sandbox
          execution · Python scientific engine
        </p>
      </footer>
    </div>
  );
}

function Console({
  user,
  selectedDomain,
  onSelectDomain,
}: {
  user: User;
  selectedDomain: DomainValue | '';
  onSelectDomain: (domain: DomainValue) => void;
}) {
  const api = useMemo(() => new AuditApi(user), [user]);
  const [history, setHistory] = useState<Audit[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<
    z.infer<typeof RevisionsResponse>['revisions']
  >([]);
  const [revisionCursor, setRevisionCursor] = useState<string | null>(null);
  const [revisionError, setRevisionError] = useState('');
  const [audit, setAudit] = useState<Audit | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [progress, setProgress] = useState<ProgressSnapshot | null>(null);
  const [questions, setQuestions] = useState<Questions | null>(null);
  const [report, setReport] = useState<ResponseReport | null>(null);
  const [reportRead, setReportRead] = useState<
    'idle' | 'loading' | 'missing' | 'failed'
  >('idle');
  const [reportError, setReportError] = useState('');
  const [refreshCount, setRefreshCount] = useState(0);
  const [answers, setAnswers] = useState<
    Record<string, { option: string | null; text: string }>
  >({});
  const [title, setTitle] = useState('');
  const [density, setDensity] = useState('');
  const [heatCapacity, setHeatCapacity] = useState('');
  const [domain, setDomain] = useState<DomainValue | ''>(selectedDomain);
  const [files, setFiles] = useState<File[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [reuseArtifacts, setReuseArtifacts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [readIssue, setReadIssue] = useState('');
  const [historyState, setHistoryState] = useState('Loading private history…');
  const selection = useRef(0);
  const refreshSequence = useRef(0);
  const alive = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api.activate();
    alive.current = true;
    return () => {
      api.dispose();
      alive.current = false;
      selection.current++;
    };
  }, [api]);
  useEffect(() => {
    if (selectedDomain) setDomain(selectedDomain);
  }, [selectedDomain]);
  useEffect(() => {
    setDensity('');
    setHeatCapacity('');
  }, [audit?.id, workspace?.revisionId]);
  const showError = useCallback((reason: unknown) => {
    if (alive.current) setError(errorText(reason));
  }, []);
  const loadHistory = useCallback(
    async (cursor?: string) => {
      try {
        const value = await api.get(
          `/audits?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          AuditHistoryResponse,
        );
        if (alive.current) {
          setHistory((previous) =>
            cursor
              ? [
                  ...previous,
                  ...value.audits.filter(
                    (item) =>
                      !previous.some((existing) => existing.id === item.id),
                  ),
                ]
              : value.audits,
          );
          setHistoryCursor(value.nextCursor);
          setHistoryState(
            value.audits.length || cursor
              ? ''
              : 'No audits yet. Create your first audit below.',
          );
        }
      } catch (reason) {
        if (alive.current) setHistoryState(errorText(reason));
      }
    },
    [api],
  );
  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);
  const path = audit
    ? `/audits/${audit.id}/revisions/${audit.currentRevisionId}`
    : '';
  const loadRevisions = useCallback(
    async (selected: Audit, cursor?: string) => {
      const token = selection.current;
      try {
        const value = await api.get(
          `/audits/${selected.id}/revisions?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          RevisionsResponse,
        );
        if (alive.current && token === selection.current) {
          setRevisions((previous) =>
            cursor
              ? [
                  ...previous,
                  ...value.revisions.filter(
                    (item) =>
                      !previous.some(
                        (existing) => existing.revisionId === item.revisionId,
                      ),
                  ),
                ]
              : value.revisions,
          );
          setRevisionCursor(value.nextCursor);
          setRevisionError('');
        }
      } catch (reason) {
        if (alive.current && token === selection.current)
          setRevisionError(errorText(reason));
      }
    },
    [api],
  );
  useEffect(() => {
    if (audit) {
      setRevisions([]);
      setRevisionCursor(null);
      void loadRevisions(audit);
    }
  }, [audit?.id, audit?.currentRevisionId, loadRevisions]);
  const refresh = useCallback(
    async (selected: Audit, token = selection.current) => {
      const sequence = ++refreshSequence.current;
      const base = `/audits/${selected.id}/revisions/${selected.currentRevisionId}`;
      const results = await Promise.allSettled([
        api.get(`${base}/workspace`, Workspace),
        api.get(`${base}/progress`, ProgressSnapshot),
      ]);
      if (
        !alive.current ||
        token !== selection.current ||
        sequence !== refreshSequence.current
      )
        return;
      const [details, state] = results;
      if (details.status === 'fulfilled') setWorkspace(details.value);
      if (state.status === 'fulfilled') setProgress(state.value);
      if (details.status === 'rejected' || state.status === 'rejected') {
        setReadIssue(
          errorText(
            details.status === 'rejected'
              ? details.reason
              : state.status === 'rejected'
                ? state.reason
                : undefined,
          ) || 'The saved state could not be read.',
        );
        return;
      }
      setReadIssue('');
      return state.status === 'fulfilled'
        ? state.value.pollAfterSeconds
        : undefined;
    },
    [api],
  );
  async function open(selected: Audit) {
    const token = ++selection.current;
    setAudit(selected);
    setWorkspace(null);
    setProgress(null);
    setQuestions(null);
    setReport(null);
    setReportRead('idle');
    setReportError('');
    setAnswers({});
    setError('');
    setNotice('');
    setReadIssue('');
    setFiles([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setReuseArtifacts(null);
    await refresh(selected, token);
  }
  useEffect(() => {
    if (!audit) return;
    const token = selection.current;
    return startReadPolling(() => refresh(audit, token));
  }, [audit, refresh]);
  useEffect(() => {
    if (!audit || !progress) return;
    let active = true;
    const token = selection.current;
    const base = `/audits/${audit.id}/revisions/${audit.currentRevisionId}`;
    if (
      progress.status === 'waiting_for_input' &&
      progress.stage === 'clarifying'
    ) {
      void api
        .get(`${base}/questions`, QuestionsResponse)
        .then((value) => {
          if (active && alive.current && token === selection.current)
            setQuestions(value);
        })
        .catch((reason) => {
          if (active && alive.current && token === selection.current)
            showError(reason);
        });
    } else setQuestions(null);
    if (
      progress.stage === 'reporting' ||
      ['completed', 'partial', 'failed', 'cancelled', 'unsupported'].includes(
        progress.status,
      )
    ) {
      setReportRead('loading');
      setReportError('');
      void api
        .get(`${base}/report`, EvidenceReportResponse)
        .then((value) => {
          if (active && alive.current && token === selection.current) {
            setReport(value);
            setReportRead('idle');
          }
        })
        .catch((reason) => {
          if (!active || !alive.current || token !== selection.current) return;
          if (
            reason instanceof RequestFailure &&
            ['not_found', 'report_not_ready'].includes(reason.code)
          ) {
            setReport(null);
            setReportRead('missing');
            return;
          }
          setReportRead('failed');
          setReportError(errorText(reason));
        });
    }
    return () => {
      active = false;
    };
  }, [
    api,
    audit,
    progress?.status,
    progress?.stage,
    progress?.updatedAt,
    refreshCount,
    showError,
  ]);
  async function act(name: string, action: () => Promise<void>) {
    if (busy) return;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (reason) {
      showError(reason);
    } finally {
      if (alive.current) {
        setBusy('');
        requestAnimationFrame(() => errorRef.current?.focus());
      }
    }
  }
  async function create() {
    if (!domain || !title.trim()) {
      setError('Enter an audit title and choose a domain.');
      return;
    }
    const value = await api.mutate(
      '/audits',
      'POST',
      { schemaVersion: '1.0', title: title.trim(), domain },
      AuditResponse,
    );
    await open(value.audit);
    setTitle('');
    await loadHistory();
  }
  async function upload() {
    if (!workspace || !audit) return;
    // Check bounded metadata before allocating/hashing file contents.
    if (
      files.length > DEFAULT_POLICY.uploadFiles ||
      files.reduce((total, file) => total + file.size, 0) >
        DEFAULT_POLICY.uploadBytes ||
      files
        .filter((file) => file.name.endsWith('.py'))
        .reduce((total, file) => total + file.size, 0) >
        DEFAULT_POLICY.sourceBytes
    ) {
      setError('Selected files exceed the upload or Python source limit.');
      return;
    }
    let current = await api.get(`${path}/workspace`, Workspace);
    setWorkspace(current);
    const payloads = await Promise.all(
      files.map(async (file, index) => {
        const bytes = await file.arrayBuffer();
        return {
          file,
          path: filePaths[index] ?? file.name,
          bytes,
          sha256: await digestBytes(bytes),
        };
      }),
    );
    const manifest = [
      ...current.uploads,
      ...payloads
        .filter(
          (item) =>
            !current.uploads.some(
              (upload) =>
                upload.path === item.path &&
                upload.sha256 === item.sha256 &&
                upload.bytes === item.bytes.byteLength,
            ),
        )
        .map((item) => ({
          schemaVersion: '1.0',
          artifactId: crypto.randomUUID(),
          path: item.path,
          bytes: item.bytes.byteLength,
          sha256: item.sha256,
        })),
    ];
    const check = preflightUploads(manifest);
    if (check.status !== 'ready') {
      setError(
        `Upload cannot proceed: ${check.reasons.map(label).join('; ')}.`,
      );
      return;
    }
    for (const item of payloads) {
      const existing = current.uploads.find(
        (upload) =>
          upload.path === item.path &&
          upload.sha256 === item.sha256 &&
          upload.bytes === item.bytes.byteLength,
      );
      if (
        existing &&
        current.uploadStates.some(
          (state) =>
            state.artifactId === existing.artifactId &&
            state.lifecycle === 'ready',
        )
      )
        continue;
      const reserved =
        existing ??
        (await api.mutate(
          `${path}/artifacts`,
          'POST',
          {
            schemaVersion: '1.0',
            path: item.path,
            bytes: item.bytes.byteLength,
            sha256: item.sha256,
            expectedGeneration: current.generation,
            expectedInputDigest: current.inputDigest,
          },
          UploadReservation,
        ));
      try {
        await api.upload(
          `${path}/artifacts/${reserved.artifactId}/content`,
          item.bytes,
          item.sha256,
        );
      } finally {
        // Preserve any accepted reservation even when its byte transfer failed.
        current = await api.get(`${path}/workspace`, Workspace);
        if (alive.current) setWorkspace(current);
      }
    }
    setFiles([]);
    setFilePaths([]);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setNotice(
      'Upload bytes stored. Readiness and scientific applicability still need inspection.',
    );
    await refresh(audit);
  }
  const locked =
    !!busy ||
    !workspace ||
    !progress?.isCurrentRevision ||
    workspace.stage !== 'draft' ||
    workspace.status !== 'idle';
  const disclosureMutationDisabled =
    !!busy ||
    !workspace ||
    !progress?.isCurrentRevision ||
    !audit ||
    workspace.stage !== 'draft' ||
    workspace.status !== 'idle';
  return (
    <div className="console-layout">
      <aside className="panel history">
        <div className="section-heading">
          <h2>Private history</h2>
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() => void loadHistory()}
          >
            Refresh
          </button>
        </div>
        {historyState && <p>{historyState}</p>}
        <ul>
          {history.map((item) => (
            <li key={item.id}>
              <button
                className={
                  audit?.id === item.id
                    ? 'history-item selected'
                    : 'history-item'
                }
                disabled={!!busy}
                onClick={() => void open(item)}
              >
                <strong>{item.title}</strong>
                <span>{label(item.domain)}</span>
                <small>{new Date(item.updatedAt).toLocaleString()}</small>
              </button>
            </li>
          ))}
        </ul>
        {historyCursor && (
          <button
            className="secondary"
            disabled={!!busy}
            onClick={() => void loadHistory(historyCursor)}
          >
            Load older audits
          </button>
        )}
      </aside>
      <div className="workspace">
        {error && (
          <div ref={errorRef} tabIndex={-1} className="error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        <section className="panel new-audit-panel">
          <p className="eyebrow">New audit</p>
          <h1>Choose the physics. Bring your code.</h1>
          <label htmlFor="audit-title">Audit title</label>
          <input
            id="audit-title"
            maxLength={160}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <fieldset disabled={!!busy}>
            <legend>Simulation domain · required</legend>
            <label className="choice">
              <input
                type="radio"
                name="domain"
                checked={domain === 'heat_diffusion'}
                onChange={() => {
                  setDomain('heat_diffusion');
                  onSelectDomain('heat_diffusion');
                }}
              />
              <span>
                <strong>Heat Diffusion</strong>
                <small>
                  Linear transient 1D/2D diffusion, uniform Cartesian grid,
                  constant material properties.
                </small>
              </span>
            </label>
            <label className="choice">
              <input
                type="radio"
                name="domain"
                checked={domain === 'orbital_dynamics'}
                onChange={() => {
                  setDomain('orbital_dynamics');
                  onSelectDomain('orbital_dynamics');
                }}
              />
              <span>
                <strong>Orbital Dynamics</strong>
                <small>
                  Deterministic Newtonian point masses, isolated mutual gravity
                  or a fixed central field.
                </small>
              </span>
            </label>
          </fieldset>
          <button
            disabled={!!busy}
            onClick={() => void act('Creating audit', create)}
          >
            Create private audit
          </button>
        </section>
        {!audit && (
          <div className="workspace-placeholders">
            <section className="panel" id="testplan">
              <h2>Deterministic test plan</h2>
              <p>Select or create an audit to see its plan.</p>
            </section>
            <section className="panel" id="evidence">
              <h2>Evidence report</h2>
              <p>Select an audit to see its report when available.</p>
            </section>
          </div>
        )}
        {audit && (
          <>
            {readIssue && (
              <section className="panel warning" role="status">
                <h2>Saved state could not be refreshed</h2>
                <p>{readIssue}</p>
                <p>
                  Displayed information may be out of date. Siphon will retry
                  reading saved state automatically. Use Refresh audit to check
                  now. Reconnecting does not start experiments or repeat work.
                </p>
              </section>
            )}
            {!!workspace?.operationalIssues.length && (
              <section
                className="panel warning"
                role="status"
                aria-live="polite"
              >
                <h2>Audit needs attention</h2>
                {workspace.operationalIssues.map((issue) => (
                  <p key={issue.code}>
                    {issue.message} ({issue.code})
                  </p>
                ))}
                {['inspecting', 'clarifying', 'adapting'].includes(
                  workspace.stage,
                ) &&
                  workspace.status === 'running' && (
                    <button
                      disabled={!!busy || !progress?.isCurrentRevision}
                      onClick={() =>
                        void act('Resuming review', async () => {
                          await api.mutate(
                            `/audits/${audit.id}/revisions/${workspace.revisionId}/resume`,
                            'POST',
                            {
                              schemaVersion: '1.0',
                              expectedGeneration: workspace.generation,
                              expectedInputDigest: workspace.inputDigest,
                            },
                            ResumedAuditReceipt,
                          );
                          await refresh(audit);
                        })
                      }
                    >
                      Retry review after setup is resolved
                    </button>
                  )}
              </section>
            )}
            <section className="panel active-audit-panel">
              <div className="section-heading">
                <div>
                  <p className="eyebrow">{label(audit.domain)}</p>
                  <h2>{audit.title}</h2>
                </div>
                <button
                  className="secondary"
                  disabled={!!busy}
                  onClick={() =>
                    void act('Refreshing', async () => {
                      const value = await api.get(
                        `/audits/${audit.id}`,
                        AuditResponse,
                      );
                      setAudit(value.audit);
                      await refresh(value.audit);
                      setRefreshCount((count) => count + 1);
                    })
                  }
                >
                  Refresh audit
                </button>
              </div>
              <p className="identifier">Revision {audit.currentRevisionId}</p>
              <details>
                <summary>Revision history</summary>
                {revisionError && <p className="warning">{revisionError}</p>}
                <ul>
                  {revisions.map((revision) => (
                    <li key={revision.revisionId}>
                      <button
                        className="text-button"
                        disabled={
                          !!busy ||
                          revision.revisionId === audit.currentRevisionId
                        }
                        onClick={() =>
                          void open({
                            ...audit,
                            currentRevisionId: revision.revisionId,
                          })
                        }
                      >
                        {revision.revisionId} · {label(revision.stage)} ·{' '}
                        {label(revision.status)}
                      </button>
                      <small>
                        {new Date(revision.createdAt).toLocaleString()} ·{' '}
                        {revision.reportId
                          ? 'Report recorded'
                          : 'No report recorded'}
                      </small>
                    </li>
                  ))}
                </ul>
                {revisionCursor && (
                  <button
                    className="secondary"
                    disabled={!!busy}
                    onClick={() => void loadRevisions(audit, revisionCursor)}
                  >
                    Load older revisions
                  </button>
                )}
              </details>
              <div aria-live="polite" aria-atomic="true" className="progress">
                <strong>
                  {progress
                    ? `${label(progress.stage)} · ${label(progress.status)}`
                    : readIssue
                      ? 'Saved progress unavailable'
                      : 'Loading persisted state…'}
                </strong>
                <p>
                  {progress?.progress?.message ??
                    'No activity message has been recorded.'}
                </p>
                {progress?.progress?.experiments && (
                  <p>
                    {progress.progress.experiments.completed} /{' '}
                    {progress.progress.experiments.planned} experiments
                    completed
                  </p>
                )}
                {progress && (
                  <small>
                    Updated {new Date(progress.updatedAt).toLocaleString()}
                    {progress.progress?.timelineCapped
                      ? ' · activity history capped'
                      : ''}
                  </small>
                )}
              </div>
              {progress && !progress.isCurrentRevision && (
                <p className="warning">
                  This revision is historical. Refresh the audit before starting
                  new work.
                </p>
              )}
              {workspace && (
                <AiDisclosurePanel
                  disclosure={workspace.aiDisclosure}
                  disabled={disclosureMutationDisabled}
                  onDecision={(decision) =>
                    void act(
                      decision === 'accept'
                        ? 'Recording AI data sharing permission'
                        : 'Revoking AI data sharing permission',
                      async () => {
                        if (!workspace) return;
                        const receipt = await api.mutate(
                          `${path}/ai-disclosure`,
                          'POST',
                          {
                            schemaVersion: '1.0',
                            expectedGeneration: workspace.generation,
                            expectedInputDigest: workspace.inputDigest,
                            disclosureDigest:
                              workspace.aiDisclosure!.disclosureDigest,
                            decision,
                          },
                          AiDisclosureReceipt,
                        );
                        if (
                          receipt.auditId !== audit?.id ||
                          receipt.revisionId !== audit.currentRevisionId ||
                          receipt.disclosureDigest !==
                            workspace.aiDisclosure!.disclosureDigest ||
                          receipt.decision !== decision
                        )
                          throw new Error(
                            'The AI permission response did not match this audit revision.',
                          );
                        await refresh(audit);
                        setNotice(
                          decision === 'accept'
                            ? 'AI data sharing permission is recorded for this revision.'
                            : 'Permission revoked for future authorized AI dispatches. Data already sent cannot be recalled.',
                        );
                      },
                    )
                  }
                />
              )}
              <p className="muted" id="run-disclosure">
                Starting a review sends reviewed Python source to the configured
                Groq model for context and mappings. Validated numerical
                evidence may also be sent for advisory investigation. Uploads
                execute only in isolated E2B environments. Remove secrets and
                private information before uploading; source scanning cannot
                guarantee their absence. Siphon recommends investigations and
                does not apply repairs.
              </p>
              <div className="actions">
                <button
                  aria-describedby="run-disclosure"
                  disabled={
                    locked ||
                    workspace?.aiDisclosure?.status !== 'accepted' ||
                    !workspace?.uploads.length ||
                    workspace?.uploadStates.some(
                      (upload) => upload.lifecycle !== 'ready',
                    ) ||
                    !progress?.isCurrentRevision
                  }
                  onClick={() =>
                    void act('Starting audit', async () => {
                      if (!workspace) return;
                      await api.mutate(
                        `${path}/run`,
                        'POST',
                        {
                          schemaVersion: '1.0',
                          expectedGeneration: workspace.generation,
                          expectedInputDigest: workspace.inputDigest,
                        },
                        QueuedAuditReceipt,
                      );
                      setNotice(
                        'Run accepted. Progress below comes from persisted backend state.',
                      );
                      await refresh(audit);
                    })
                  }
                >
                  Start readiness and audit
                </button>
                <button
                  className="secondary"
                  disabled={
                    !!busy ||
                    !progress ||
                    !progress.isCurrentRevision ||
                    [
                      'completed',
                      'partial',
                      'failed',
                      'cancelled',
                      'unsupported',
                    ].includes(progress.status)
                  }
                  onClick={() =>
                    void act('Requesting cancellation', async () => {
                      const value = await api.mutate(
                        `${path}/cancel`,
                        'POST',
                        undefined,
                        CommandReceipt,
                      );
                      setNotice(
                        `Cancellation recorded. Cleanup ${value.cleanup}; provider termination is confirmed only when cleanup is confirmed.`,
                      );
                      await refresh(audit);
                    })
                  }
                >
                  Cancel work
                </button>
                <button
                  className="danger"
                  disabled={!!busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Delete “${audit.title}” and every revision? Access is revoked immediately; background cleanup may remain pending.`,
                      )
                    )
                      void act('Requesting deletion', async () => {
                        const value = await api.mutate(
                          `/audits/${audit.id}`,
                          'DELETE',
                          undefined,
                          CommandReceipt,
                        );
                        selection.current++;
                        setAudit(null);
                        setWorkspace(null);
                        setProgress(null);
                        setQuestions(null);
                        setReport(null);
                        setAnswers({});
                        setNotice(
                          `Deletion requested. Access revoked. Cleanup ${value.cleanup}.`,
                        );
                        await loadHistory();
                      });
                  }}
                >
                  Delete audit
                </button>
              </div>
            </section>
            <section className="panel upload-panel">
              <h2>Source and supporting data</h2>
              <p>
                Existing .py scripts with optional .csv/.npy numeric input. No
                required template. Maximum {DEFAULT_POLICY.uploadFiles} files,{' '}
                {DEFAULT_POLICY.uploadBytes / 1048576} MiB total,{' '}
                {DEFAULT_POLICY.sourceBytes / 1024} KiB Python. Object/pickled
                arrays and unrestricted package installation are unsupported.
              </p>
              <p className="muted">
                Raw uploads/evidence have limited retention (normally 7 days);
                reports normally 30 days. Reuse does not extend original expiry.
              </p>
              {workspace?.uploads.length ? (
                <ul>
                  {workspace.uploads.map((file) => (
                    <li key={file.artifactId}>
                      {file.path} · {file.bytes} bytes ·{' '}
                      {workspace.uploadStates.find(
                        (state) => state.artifactId === file.artifactId,
                      )?.lifecycle ?? 'unknown'}{' '}
                      <small>
                        Recorded expiry:{' '}
                        {workspace.uploadStates.find(
                          (state) => state.artifactId === file.artifactId,
                        )?.expiresAt ?? 'unknown'}
                      </small>
                      <small className="identifier">
                        SHA-256 {file.sha256}
                      </small>
                      <label className="option">
                        <input
                          type="checkbox"
                          disabled={!!busy}
                          checked={(
                            reuseArtifacts ??
                            workspace.uploads.map((upload) => upload.artifactId)
                          ).includes(file.artifactId)}
                          onChange={(event) =>
                            setReuseArtifacts((previous) => {
                              const current =
                                previous ??
                                workspace.uploads.map(
                                  (upload) => upload.artifactId,
                                );
                              return event.target.checked
                                ? [...current, file.artifactId]
                                : current.filter(
                                    (id) => id !== file.artifactId,
                                  );
                            })
                          }
                        />
                        Reuse in next successor draft
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p>No source uploads recorded.</p>
              )}
              <div
                className={`upload-dropzone${locked ? ' is-disabled' : ''}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  if (locked) return;
                  const chosen = Array.from(event.dataTransfer.files);
                  setFiles(chosen);
                  setFilePaths(chosen.map((file) => file.name));
                }}
              >
                <label htmlFor="files">
                  Drop simulation files here or choose files
                </label>
                <p>Python source and optional CSV or NPY data.</p>
                <input
                  id="files"
                  ref={fileInputRef}
                  disabled={locked}
                  type="file"
                  accept=".py,.csv,.npy"
                  multiple
                  onChange={(event) => {
                    const chosen = Array.from(event.target.files ?? []);
                    setFiles(chosen);
                    setFilePaths(chosen.map((file) => file.name));
                  }}
                />
              </div>
              {files.length > 0 && (
                <ul>
                  {files.map((file, index) => (
                    <li key={index}>
                      {file.name} · {file.size} bytes
                      <label htmlFor={`upload-path-${index}`}>
                        Relative path in simulation
                      </label>
                      <input
                        id={`upload-path-${index}`}
                        disabled={!!busy}
                        maxLength={240}
                        value={filePaths[index] ?? file.name}
                        onChange={(event) =>
                          setFilePaths((previous) =>
                            previous.map((path, pathIndex) =>
                              pathIndex === index ? event.target.value : path,
                            ),
                          )
                        }
                      />
                    </li>
                  ))}
                </ul>
              )}
              <button
                disabled={locked || !files.length}
                onClick={() => void act('Uploading source', upload)}
              >
                Upload selected files
              </button>
              {workspace &&
                (workspace.stage !== 'draft' ||
                  workspace.status !== 'idle') && (
                  <p>
                    Source is frozen for this revision. Create a successor draft
                    to change inputs.
                  </p>
                )}
              {workspace &&
                [
                  'idle',
                  'completed',
                  'partial',
                  'failed',
                  'cancelled',
                  'waiting_for_input',
                ].includes(workspace.status) && (
                  <button
                    className="secondary"
                    disabled={!!busy || !progress?.isCurrentRevision}
                    onClick={() =>
                      void act('Creating successor', async () => {
                        const receipt = await api.mutate(
                          `/audits/${audit.id}/revisions`,
                          'POST',
                          {
                            schemaVersion: '1.0',
                            parentRevisionId: workspace.revisionId,
                            expectedGeneration: workspace.generation,
                            expectedInputDigest: workspace.inputDigest,
                            reuseArtifactIds:
                              reuseArtifacts ??
                              workspace.uploads.map((item) => item.artifactId),
                          },
                          RevisionReceipt,
                        );
                        await open({
                          ...audit,
                          currentRevisionId: receipt.revisionId,
                        });
                        await loadHistory();
                      })
                    }
                  >
                    Create successor draft with selected inputs
                  </button>
                )}
            </section>
            <section className="panel context-panel">
              <h2>Readiness and simulation context</h2>
              {workspace?.adapterProposal && (
                <div>
                  <h3>Proposed observation mapping</h3>
                  <p>
                    AI has proposed how to read the simulation's existing
                    arrays. Baseline execution, numeric validation and
                    comparison must complete before this mapping is verified.
                  </p>
                  <p>
                    Entry artifact:{' '}
                    <code>{workspace.adapterProposal.sourceArtifactId}</code>
                  </p>
                  <ul>
                    {workspace.adapterProposal.mappings.map((mapping) => (
                      <li key={mapping.key}>
                        <strong>{label(mapping.key)}</strong>:{' '}
                        <code>{mapping.root}</code>
                        {mapping.steps.length > 0 && (
                          <span>
                            {' '}
                            · {mapping.steps.length} literal access steps
                          </span>
                        )}
                        {' · '}expected shape{' '}
                        {mapping.expectedShape.join(' × ')}
                        {' · '}declared unit {mapping.declaredUnit}
                      </li>
                    ))}
                  </ul>
                  {workspace.adapterQuestions && (
                    <div>
                      <h4>Review the proposed mappings</h4>
                      <p>
                        Your answers are saved as declarations. They do not by
                        themselves verify the adapter.
                      </p>
                      {workspace.adapterReview ? (
                        <>
                          <p role="status">
                            Mapping review saved.{' '}
                            {workspace.adapterReview.allDeclaredConfirmed
                              ? 'All mappings were declared confirmed.'
                              : 'Some answers need further review.'}
                          </p>
                          {workspace.adapterReview.allDeclaredConfirmed && (
                            <button
                              type="button"
                              className="secondary"
                              disabled={
                                !!busy ||
                                !progress?.isCurrentRevision ||
                                workspace.stage !== 'adapting'
                              }
                              onClick={() =>
                                void act(
                                  'Continuing mapping review',
                                  async () => {
                                    const result = await api.mutate(
                                      `${path}/adapter-review/continue`,
                                      'POST',
                                      {
                                        schemaVersion: '1.0',
                                        expectedGeneration:
                                          workspace.generation,
                                        expectedInputDigest:
                                          workspace.inputDigest,
                                      },
                                      z.object({
                                        schemaVersion: z.literal('1.0'),
                                        status: z.enum([
                                          'waiting',
                                          'comparison_unmatched',
                                          'continued',
                                        ]),
                                      }),
                                    );
                                    await refresh(audit);
                                    setNotice(
                                      result.status === 'continued'
                                        ? 'Mapping verification continued.'
                                        : result.status === 'waiting'
                                          ? 'Waiting for the baseline comparison.'
                                          : 'The baseline outputs did not match; dependent checks cannot continue.',
                                    );
                                  },
                                )
                              }
                            >
                              Continue mapping verification
                            </button>
                          )}
                        </>
                      ) : (
                        <>
                          {workspace.adapterQuestions.questions.map(
                            (question) => {
                              const answer = answers[question.id] ?? {
                                option: null,
                                text: '',
                              };
                              return (
                                <fieldset key={question.id} disabled={!!busy}>
                                  <legend>{question.prompt}</legend>
                                  <p>{question.reason}</p>
                                  {question.options.map((option) => (
                                    <label key={option.id}>
                                      <input
                                        type="radio"
                                        name={`adapter-${question.id}`}
                                        checked={answer.option === option.id}
                                        onChange={() =>
                                          setAnswers((previous) => ({
                                            ...previous,
                                            [question.id]: {
                                              ...answer,
                                              option: option.id,
                                            },
                                          }))
                                        }
                                      />
                                      {option.label}
                                    </label>
                                  ))}
                                  <button
                                    type="button"
                                    className="text-button"
                                    onClick={() =>
                                      setAnswers((previous) => ({
                                        ...previous,
                                        [question.id]: {
                                          ...answer,
                                          option: null,
                                        },
                                      }))
                                    }
                                  >
                                    Clear option
                                  </button>
                                  <label
                                    htmlFor={`adapter-custom-${question.id}`}
                                  >
                                    Custom answer or correction
                                  </label>
                                  <textarea
                                    id={`adapter-custom-${question.id}`}
                                    rows={3}
                                    maxLength={4000}
                                    value={answer.text}
                                    onChange={(event) =>
                                      setAnswers((previous) => ({
                                        ...previous,
                                        [question.id]: {
                                          ...answer,
                                          text: event.target.value,
                                        },
                                      }))
                                    }
                                  />
                                </fieldset>
                              );
                            },
                          )}
                          <button
                            disabled={
                              !!busy ||
                              !progress?.isCurrentRevision ||
                              workspace.stage !== 'adapting'
                            }
                            onClick={() =>
                              void act('Saving mapping review', async () => {
                                if (
                                  !workspace.adapterQuestions ||
                                  !workspace.adapterDigest ||
                                  !workspace.adapterQuestionSetDigest
                                )
                                  return;
                                const raw =
                                  workspace.adapterQuestions.questions.map(
                                    (question) => ({
                                      schemaVersion: '1.0',
                                      questionId: question.id,
                                      selectedOptionId:
                                        answers[question.id]?.option ?? null,
                                      customText:
                                        answers[question.id]?.text ?? '',
                                    }),
                                  );
                                if (
                                  raw.some(
                                    (answer) =>
                                      !answer.selectedOptionId &&
                                      !answer.customText.trim(),
                                  )
                                )
                                  throw new Error(
                                    'Answer every mapping question',
                                  );
                                await api.mutate(
                                  `/audits/${audit.id}/revisions/${workspace.revisionId}/adapter-review`,
                                  'POST',
                                  {
                                    schemaVersion: '1.0',
                                    expectedGeneration: workspace.generation,
                                    expectedInputDigest: workspace.inputDigest,
                                    adapterDigest: workspace.adapterDigest,
                                    questionSetDigest:
                                      workspace.adapterQuestionSetDigest,
                                    answers: raw,
                                  },
                                  z.object({
                                    schemaVersion: z.literal('1.0'),
                                    resultDigest: Digest,
                                    allDeclaredConfirmed: z.boolean(),
                                    replayed: z.boolean(),
                                  }),
                                );
                                await refresh(audit);
                              })
                            }
                          >
                            Save mapping review
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
              {workspace?.readiness ? (
                <>
                  <strong>{label(workspace.readiness.status)}</strong>
                  <ul>
                    {workspace.readiness.findings.map((finding, i) => (
                      <li key={i}>
                        {label(finding.code)}
                        {finding.artifactId ? ` · ${finding.artifactId}` : ''}
                        {finding.line ? ` line ${finding.line}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p>
                    Next: {label(workspace.readiness.next)}. Readiness is
                    distinct from a numerical pass.
                  </p>
                </>
              ) : (
                <p>No readiness assessment has been published.</p>
              )}
              {workspace?.context ? (
                <>
                  <h3>AI context · unverified interpretation</h3>
                  <p>{workspace.context.summary}</p>
                  {workspace.context.domainMismatchSuspected && (
                    <p className="warning">
                      The chosen domain may not match the source. Resolve this
                      before dependent checks.
                    </p>
                  )}
                  <ul>
                    {workspace.context.candidates.map((candidate, i) => (
                      <li key={i}>
                        <strong>
                          {label(candidate.field)} ·{' '}
                          {label(candidate.uncertainty)}
                        </strong>
                        <p>{candidate.description}</p>
                        <small>
                          {candidate.citations
                            .map(
                              (citation) =>
                                `${citation.artifactId}, lines ${citation.startLine}–${citation.endLine}`,
                            )
                            .join('; ') || 'No source citation recorded'}
                        </small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p>No AI explanation has been published.</p>
              )}
            </section>
            {questions && (
              <section className="panel clarification-panel">
                <h2>Clarify the simulation</h2>
                <p>
                  Choose an option, add custom text, or both. Unknown answers
                  are valid; affected checks may remain blocked. Both inputs are
                  preserved for reconciliation.
                </p>
                {questions.questionSet.questions.map((question) => {
                  const answer = answers[question.id] ?? {
                    option: null,
                    text: '',
                  };
                  return (
                    <fieldset key={question.id} disabled={!!busy}>
                      <legend>{question.prompt}</legend>
                      <p>{question.reason}</p>
                      {question.options.map((option) => (
                        <label className="option" key={option.id}>
                          <input
                            type="radio"
                            name={question.id}
                            checked={answer.option === option.id}
                            onChange={() =>
                              setAnswers((previous) => ({
                                ...previous,
                                [question.id]: { ...answer, option: option.id },
                              }))
                            }
                          />
                          {option.label}
                          {option.unknown ? ' (unknown)' : ''}
                        </label>
                      ))}
                      <button
                        className="text-button"
                        type="button"
                        onClick={() =>
                          setAnswers((previous) => ({
                            ...previous,
                            [question.id]: { ...answer, option: null },
                          }))
                        }
                      >
                        Clear option
                      </button>
                      <label htmlFor={`custom-${question.id}`}>
                        Custom answer or additional context
                      </label>
                      <textarea
                        id={`custom-${question.id}`}
                        maxLength={4000}
                        rows={3}
                        value={answer.text}
                        onChange={(event) =>
                          setAnswers((previous) => ({
                            ...previous,
                            [question.id]: {
                              ...answer,
                              text: event.target.value,
                            },
                          }))
                        }
                      />
                      <small>
                        Affected checks:{' '}
                        {question.affectedChecks.join(', ') ||
                          'context resolution'}
                      </small>
                    </fieldset>
                  );
                })}
                <button
                  disabled={
                    !!busy || !workspace || !progress?.isCurrentRevision
                  }
                  onClick={() =>
                    void act('Submitting answers', async () => {
                      if (!workspace) return;
                      const raw = questions.questionSet.questions.map(
                        (question) => ({
                          schemaVersion: '1.0',
                          questionId: question.id,
                          selectedOptionId:
                            answers[question.id]?.option ?? null,
                          customText: answers[question.id]?.text ?? '',
                        }),
                      );
                      if (
                        raw.some(
                          (answer) =>
                            !answer.selectedOptionId &&
                            !answer.customText.trim(),
                        )
                      ) {
                        setError(
                          'Answer each question using an option or custom text. Use an unknown option when appropriate.',
                        );
                        return;
                      }
                      const receipt = await api.mutate(
                        `${path}/answers`,
                        'POST',
                        {
                          schemaVersion: '1.0',
                          expectedGeneration: workspace.generation,
                          expectedInputDigest: workspace.inputDigest,
                          questionSetDigest: questions.questionSetDigest,
                          answers: raw,
                        },
                        RevisionReceipt,
                      );
                      await open({
                        ...audit,
                        currentRevisionId: receipt.revisionId,
                      });
                      setNotice(
                        'Answers saved in a successor revision. Start the next stage when ready.',
                      );
                      await loadHistory();
                    })
                  }
                >
                  Save answers as successor revision
                </button>
              </section>
            )}
            {workspace?.scientificQuestions && (
              <section className="panel">
                <h2>Scientific context</h2>
                {workspace.scientificQuestions.answer ? (
                  <>
                    <p role="status">
                      Your answer was saved. You can recheck eligibility if the
                      assessment was interrupted.
                    </p>
                    <button
                      type="button"
                      className="secondary"
                      disabled={!!busy || !progress?.isCurrentRevision}
                      onClick={() =>
                        void act(
                          'Rechecking scientific eligibility',
                          async () => {
                            const snapshot = workspace.scientificQuestions;
                            if (!snapshot?.answer) return;
                            await api.mutate(
                              `${path}/scientific-answer`,
                              'POST',
                              {
                                schemaVersion: '1.0',
                                expectedGeneration: workspace.generation,
                                expectedInputDigest: workspace.inputDigest,
                                questionSetDigest: snapshot.questionSetDigest,
                                answer: snapshot.answer,
                              },
                              z.object({
                                schemaVersion: z.literal('1.0'),
                                replayed: z.boolean(),
                                assessmentDigest: Digest,
                              }),
                            );
                            await refresh(audit);
                            setNotice('Scientific eligibility rechecked.');
                          },
                        )
                      }
                    >
                      Recheck eligibility
                    </button>
                  </>
                ) : (
                  <>
                    {workspace.scientificQuestions.questionSet.questions.map(
                      (question) => {
                        const answer = answers[question.id] ?? {
                          option: null,
                          text: '',
                        };
                        return (
                          <fieldset key={question.id} disabled={!!busy}>
                            <legend>{question.prompt}</legend>
                            <p>{question.reason}</p>
                            {question.options.map((option) => (
                              <label className="option" key={option.id}>
                                <input
                                  type="radio"
                                  name={`scientific-${question.id}`}
                                  checked={answer.option === option.id}
                                  onChange={() =>
                                    setAnswers((previous) => ({
                                      ...previous,
                                      [question.id]: {
                                        ...answer,
                                        option: option.id,
                                      },
                                    }))
                                  }
                                />
                                {option.label}
                                {option.unknown ? ' (unknown)' : ''}
                              </label>
                            ))}
                            <button
                              type="button"
                              className="text-button"
                              onClick={() =>
                                setAnswers((previous) => ({
                                  ...previous,
                                  [question.id]: { ...answer, option: null },
                                }))
                              }
                            >
                              Clear option
                            </button>
                            <label htmlFor={`scientific-custom-${question.id}`}>
                              Custom answer or additional context
                            </label>
                            <textarea
                              id={`scientific-custom-${question.id}`}
                              rows={3}
                              maxLength={4000}
                              value={answer.text}
                              onChange={(event) =>
                                setAnswers((previous) => ({
                                  ...previous,
                                  [question.id]: {
                                    ...answer,
                                    text: event.target.value,
                                  },
                                }))
                              }
                            />
                            <button
                              type="button"
                              className="secondary"
                              disabled={!progress?.isCurrentRevision}
                              onClick={() =>
                                void act(
                                  'Saving scientific answer',
                                  async () => {
                                    const snapshot =
                                      workspace.scientificQuestions;
                                    if (!snapshot) return;
                                    if (!answer.option && !answer.text.trim())
                                      throw new Error(
                                        'Choose an option or enter a custom answer.',
                                      );
                                    await api.mutate(
                                      `${path}/scientific-answer`,
                                      'POST',
                                      {
                                        schemaVersion: '1.0',
                                        expectedGeneration:
                                          workspace.generation,
                                        expectedInputDigest:
                                          workspace.inputDigest,
                                        questionSetDigest:
                                          snapshot.questionSetDigest,
                                        answer: {
                                          schemaVersion: '1.0',
                                          questionId: question.id,
                                          selectedOptionId: answer.option,
                                          customText: answer.text,
                                        },
                                      },
                                      z.object({
                                        schemaVersion: z.literal('1.0'),
                                        replayed: z.boolean(),
                                        assessmentDigest: Digest,
                                      }),
                                    );
                                    await refresh(audit);
                                    setNotice('Scientific answer saved.');
                                  },
                                )
                              }
                            >
                              Save scientific answer
                            </button>
                          </fieldset>
                        );
                      },
                    )}
                  </>
                )}
              </section>
            )}
            {workspace?.investigation && (
              <InvestigationReview
                snapshot={workspace.investigation}
                disabled={
                  !!busy ||
                  !!readIssue ||
                  !progress?.isCurrentRevision ||
                  workspace.stage !== 'investigating' ||
                  workspace.status !== 'running'
                }
                onReview={(decision) =>
                  void act('Saving advisory review', async () => {
                    const snapshot = workspace.investigation;
                    if (!snapshot) return;
                    const receipt = await api.mutate(
                      `${path}/investigation-review`,
                      'POST',
                      {
                        schemaVersion: '1.0',
                        expectedGeneration: workspace.generation,
                        expectedInputDigest: workspace.inputDigest,
                        draftDigest: snapshot.draftDigest,
                        decision,
                      },
                      InvestigationReviewReceipt.refine(
                        (value) =>
                          value.operationId === snapshot.operationId &&
                          value.draftDigest === snapshot.draftDigest &&
                          value.status ===
                            (decision === 'accept' ? 'accepted' : 'omitted'),
                      ),
                    );
                    await refresh(audit);
                    setNotice(
                      `Advisory text ${receipt.status}. Numerical verdicts are unchanged. Resume report preparation when ready.`,
                    );
                  })
                }
              />
            )}
            <section className="panel plan-panel" id="testplan">
              <h2>Deterministic test plan</h2>
              {workspace?.plan ? (
                <>
                  <p>
                    Eligibility is determined by reviewed rules. Unresolved or
                    unreleased checks do not produce passes.
                  </p>
                  {audit.domain === 'heat_diffusion' &&
                    workspace.plan.checks.some(
                      (check) =>
                        check.checkId === 'H_ENERGY' &&
                        check.selection === 'selected',
                    ) && (
                      <div>
                        <h3>Thermal material properties</h3>
                        <p>
                          Enter the constant values used by your model. These
                          are your declarations and will be used to calculate
                          sampled thermal energy.
                        </p>
                        {workspace.heatParameters ? (
                          <p>
                            Density: {workspace.heatParameters.densityKgM3}{' '}
                            kg/m³ · Specific heat capacity:{' '}
                            {workspace.heatParameters.heatCapacityJKgK} J/(kg·K)
                          </p>
                        ) : (
                          <>
                            <label htmlFor="heat-density">
                              Density (kg/m³)
                            </label>
                            <input
                              id="heat-density"
                              type="number"
                              min="0"
                              step="any"
                              value={density}
                              onChange={(event) =>
                                setDensity(event.target.value)
                              }
                            />
                            <label htmlFor="heat-capacity">
                              Specific heat capacity (J/(kg·K))
                            </label>
                            <input
                              id="heat-capacity"
                              type="number"
                              min="0"
                              step="any"
                              value={heatCapacity}
                              onChange={(event) =>
                                setHeatCapacity(event.target.value)
                              }
                            />
                            <button
                              type="button"
                              className="secondary"
                              disabled={
                                !!busy ||
                                !progress?.isCurrentRevision ||
                                workspace.stage !== 'adapting'
                              }
                              onClick={() =>
                                void act(
                                  'Saving thermal properties',
                                  async () => {
                                    if (
                                      !workspace.planDigest ||
                                      !density.trim() ||
                                      !heatCapacity.trim()
                                    )
                                      throw new Error(
                                        'Enter both thermal properties.',
                                      );
                                    const values = {
                                      densityKgM3: Number(density),
                                      heatCapacityJKgK: Number(heatCapacity),
                                    };
                                    if (
                                      !Number.isFinite(values.densityKgM3) ||
                                      !Number.isFinite(
                                        values.heatCapacityJKgK,
                                      ) ||
                                      values.densityKgM3 <= 0 ||
                                      values.heatCapacityJKgK <= 0
                                    )
                                      throw new Error(
                                        'Thermal properties must be positive finite numbers.',
                                      );
                                    await api.mutate(
                                      `${path}/heat-parameters`,
                                      'POST',
                                      {
                                        schemaVersion: '1.0',
                                        expectedGeneration:
                                          workspace.generation,
                                        expectedInputDigest:
                                          workspace.inputDigest,
                                        planDigest: workspace.planDigest,
                                        parameters: values,
                                      },
                                      z.object({
                                        schemaVersion: z.literal('1.0'),
                                        replayed: z.boolean(),
                                      }),
                                    );
                                    await refresh(audit);
                                    setNotice('Thermal properties saved.');
                                  },
                                )
                              }
                            >
                              Save thermal properties
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  {workspace.plan.assessment.decisions.map((decision) => (
                    <article className="check" key={decision.checkId}>
                      <h3>
                        {decision.checkId} · {label(decision.status)}
                      </h3>
                      <p>
                        Applicability: {label(decision.applicability)} ·{' '}
                        {decision.released ? 'released' : 'not released'}
                      </p>
                      <ul>
                        {decision.reasons.map((reason, i) => (
                          <li key={i}>
                            {reason.requirement
                              ? `${label(reason.requirement)}: `
                              : ''}
                            {label(reason.code)}
                          </li>
                        ))}
                      </ul>
                    </article>
                  ))}
                  {(audit.domain !== 'heat_diffusion' ||
                    workspace.heatParameters) &&
                    [
                      'adapting',
                      'planning',
                      'executing',
                      'evaluating',
                      'investigating',
                      'reporting',
                    ].includes(workspace.stage) && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={
                          !!busy ||
                          (resumeNeedsAiDisclosure(workspace) &&
                            workspace.aiDisclosure?.status !== 'accepted') ||
                          !progress?.isCurrentRevision ||
                          ['awaiting_review', 'expired'].includes(
                            workspace.investigation?.status ?? '',
                          ) ||
                          workspace.status !== 'running'
                        }
                        onClick={() =>
                          void act('Starting planned checks', async () => {
                            await api.mutate(
                              `${path}/scientific-run`,
                              'POST',
                              {
                                schemaVersion: '1.0',
                                expectedGeneration: workspace.generation,
                                expectedInputDigest: workspace.inputDigest,
                              },
                              ResumedAuditReceipt,
                            );
                            await refresh(audit);
                            setNotice(
                              'Evaluation or report preparation requested.',
                            );
                          })
                        }
                      >
                        {['investigating', 'reporting'].includes(
                          workspace.stage,
                        )
                          ? 'Resume report preparation'
                          : 'Run planned checks'}
                      </button>
                    )}
                  <h3>Check procedures and accuracy requirements</h3>
                  {workspace.plan.checks.map((check) => (
                    <details key={check.checkId}>
                      <summary>
                        {check.checkId} · {label(check.selection)}
                      </summary>
                      <p>{check.procedure}</p>
                      <p>
                        <strong>Accuracy policy:</strong> {check.accuracyPolicy}
                      </p>
                      <p>
                        Required observations:{' '}
                        {check.requiredObservations.join(', ')}
                      </p>
                      <ul>
                        {check.reasons.map((reason, i) => (
                          <li key={i}>{reason}</li>
                        ))}
                      </ul>
                      <p>Methods: {check.referenceIds.join(', ')}</p>
                    </details>
                  ))}
                  <h3>Planned experiments</h3>
                  {workspace.plan.experiments.map((experiment) => (
                    <details key={experiment.id}>
                      <summary>
                        {experiment.description} · {label(experiment.status)}
                      </summary>
                      <ul>
                        {experiment.controls.map((control) => (
                          <li key={control.name}>
                            {control.name}: {String(control.value)}{' '}
                            {control.unit ?? ''}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ))}
                  <ul>
                    {workspace.plan.references.map((reference) => (
                      <li key={reference.id}>
                        <a
                          href={reference.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {reference.title}
                        </a>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <>
                  <p>
                    No deterministic plan has been published. Applicable checks
                    and exclusions will appear when their prerequisites are
                    established.
                  </p>
                  {workspace?.scientificQuestions?.answer &&
                    workspace.stage === 'adapting' && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={!!busy || !progress?.isCurrentRevision}
                        onClick={() =>
                          void act('Preparing scientific plan', async () => {
                            await api.mutate(
                              `${path}/scientific-plan`,
                              'POST',
                              {
                                schemaVersion: '1.0',
                                expectedGeneration: workspace.generation,
                                expectedInputDigest: workspace.inputDigest,
                              },
                              z.object({
                                schemaVersion: z.literal('1.0'),
                                planDigest: Digest,
                                replayed: z.boolean(),
                              }),
                            );
                            await refresh(audit);
                            setNotice(
                              'Scientific plan prepared. Evaluation has not started.',
                            );
                          })
                        }
                      >
                        Prepare test plan
                      </button>
                    )}
                </>
              )}
            </section>
          </>
        )}
        {busy && (
          <p className="working" role="status">
            {busy}…
          </p>
        )}
      </div>
      {audit && (
        <div className="console-report">
          {reportRead === 'failed' && (
            <section className="panel warning" role="alert">
              <h2>Report could not be refreshed</h2>
              <p>{reportError}</p>
              {report && (
                <p>
                  The report below is the last saved view. Export availability
                  may be out of date.
                </p>
              )}
              <button
                className="secondary"
                disabled={!!busy}
                onClick={() => setRefreshCount((count) => count + 1)}
              >
                Retry report read
              </button>
            </section>
          )}
          {report ? (
            <ReportBoundary key={report.report.reportId}>
              <Suspense
                fallback={
                  <section className="panel" id="evidence" role="status">
                    Loading evidence report…
                  </section>
                }
              >
                <Report value={report} api={api} onError={showError} />
              </Suspense>
            </ReportBoundary>
          ) : (
            <section className="panel report-empty" id="evidence">
              <h2>Evidence report</h2>
              <p>
                {reportRead === 'loading'
                  ? 'Checking report availability…'
                  : reportRead === 'failed'
                    ? 'Report availability could not be checked.'
                    : reportRead === 'missing'
                      ? 'No structured report has been published for this revision.'
                      : 'A report can become available after evidence is evaluated.'}{' '}
                Refreshing reads saved results; it does not start experiments or
                render a PDF.
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
