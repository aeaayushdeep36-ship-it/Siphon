import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { z } from 'zod';
import {
  Audit,
  AuditWorkspace,
  AuditHistoryResponse,
  Digest,
  Domain,
  EvidenceReportResponse,
  ProgressSnapshot,
  QuestionSet,
  QueuedAuditReceipt,
  ResumedAuditReceipt,
  RevisionReceipt,
  UploadReservation,
  preflightUploads,
  DEFAULT_POLICY,
  RevisionHistoryResponse,
} from '@siphon/contracts';
import { AuditApi, digestBytes, RequestFailure } from './api.js';
import { auth, signIn } from './auth.js';
import { Report, label } from './Report.js';

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

function errorText(error: unknown): string {
  if (error instanceof RequestFailure)
    return `${error.message} (${error.code}${error.requestId ? `; request ${error.requestId}` : ''})`;
  return error instanceof Error && error.name === 'AbortError'
    ? ''
    : 'The request could not be completed. Check the connection and retry. Your simulation has not been changed.';
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!auth);
  const [error, setError] = useState('');
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
  return (
    <>
      <header className="site-header">
        <a href="#main" className="brand">
          Siphon<span>Simulation audit console</span>
        </a>
        {user && (
          <div className="identity">
            <span>{user.displayName ?? 'Signed in'}</span>
            <button
              className="secondary"
              onClick={() => {
                if (auth)
                  void signOut(auth).catch(() =>
                    setError('Sign-out failed. Please retry.'),
                  );
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </header>
      <main id="main">
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {!authReady ? (
          <p role="status">Checking sign-in…</p>
        ) : !user ? (
          <section className="panel welcome">
            <p className="eyebrow">Inspect · Measure · Understand</p>
            <h1>Evidence for your simulation.</h1>
            <p>
              Audit an existing Python heat-diffusion or orbital simulation.
              Review applicable numerical checks, measured evidence and
              recommendations.
            </p>
            <p>
              Google sign-in and an active invitation are required. Your audits
              stay private.
            </p>
            <button
              disabled={!auth}
              onClick={() =>
                void signIn().catch(() =>
                  setError(
                    'Google sign-in could not finish. Check the authorized domain and try again.',
                  ),
                )
              }
            >
              Continue with Google
            </button>
            {!auth && (
              <p className="warning">
                Sign-in unavailable: the operator must configure Firebase public
                web settings before this console can connect.
              </p>
            )}
          </section>
        ) : (
          <Console key={user.uid} user={user} />
        )}
      </main>
      <footer>
        Siphon audits and recommends. Results apply to the recorded checks,
        assumptions and accuracy policies.
      </footer>
    </>
  );
}

function Console({ user }: { user: User }) {
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
  const [answers, setAnswers] = useState<
    Record<string, { option: string | null; text: string }>
  >({});
  const [title, setTitle] = useState('');
  const [domain, setDomain] = useState<z.infer<typeof Domain> | ''>('');
  const [files, setFiles] = useState<File[]>([]);
  const [filePaths, setFilePaths] = useState<string[]>([]);
  const [reuseArtifacts, setReuseArtifacts] = useState<string[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [historyState, setHistoryState] = useState('Loading private history…');
  const selection = useRef(0);
  const alive = useRef(true);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    api.activate();
    alive.current = true;
    return () => {
      api.dispose();
      alive.current = false;
      selection.current++;
    };
  }, [api]);
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
            value.audits.length
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
      const base = `/audits/${selected.id}/revisions/${selected.currentRevisionId}`;
      const results = await Promise.allSettled([
        api.get(`${base}/workspace`, Workspace),
        api.get(`${base}/progress`, ProgressSnapshot),
      ]);
      if (!alive.current || token !== selection.current) return;
      const [details, state] = results;
      if (details.status === 'fulfilled') setWorkspace(details.value);
      else showError(details.reason);
      if (state.status === 'fulfilled') setProgress(state.value);
      else showError(state.reason);
    },
    [api, showError],
  );
  async function open(selected: Audit) {
    const token = ++selection.current;
    setAudit(selected);
    setWorkspace(null);
    setProgress(null);
    setQuestions(null);
    setReport(null);
    setAnswers({});
    setError('');
    setNotice('');
    setFiles([]);
    setReuseArtifacts(null);
    await refresh(selected, token);
  }
  useEffect(() => {
    if (!audit || !progress?.pollAfterSeconds) return;
    const token = selection.current;
    const timer = setTimeout(
      () => {
        void refresh(audit, token);
      },
      Math.max(10, progress.pollAfterSeconds) * 1000,
    );
    return () => clearTimeout(timer);
  }, [audit, progress, refresh]);
  useEffect(() => {
    if (!audit || !progress) return;
    const token = selection.current;
    const base = `/audits/${audit.id}/revisions/${audit.currentRevisionId}`;
    if (progress.status === 'waiting_for_input') {
      void api
        .get(`${base}/questions`, QuestionsResponse)
        .then((value) => {
          if (alive.current && token === selection.current) setQuestions(value);
        })
        .catch(showError);
    }
    if (
      ['completed', 'partial', 'failed', 'cancelled'].includes(progress.status)
    ) {
      void api
        .get(`${base}/report`, EvidenceReportResponse)
        .then((value) => {
          if (alive.current && token === selection.current) setReport(value);
        })
        .catch((reason) => {
          if (reason instanceof RequestFailure && reason.code === 'not_found')
            return;
          showError(reason);
        });
    }
  }, [api, audit, progress?.status, showError]);
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
    setNotice(
      'Upload bytes stored. Readiness and scientific applicability still need inspection.',
    );
    await refresh(audit);
  }
  const locked =
    !!busy ||
    !workspace ||
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
        <section className="panel">
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
                onChange={() => setDomain('heat_diffusion')}
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
                onChange={() => setDomain('orbital_dynamics')}
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
        {audit && (
          <>
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
                      disabled={!!busy}
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
            <section className="panel">
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
              <div className="actions">
                <button
                  disabled={
                    locked ||
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
                    ['completed', 'partial', 'failed', 'cancelled'].includes(
                      progress.status,
                    )
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
            <section className="panel">
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
              <label htmlFor="files">Choose simulation and numeric files</label>
              <input
                id="files"
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
                    disabled={!!busy}
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
            <section className="panel">
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
                        <p role="status">
                          Mapping review saved.{' '}
                          {workspace.adapterReview.allDeclaredConfirmed
                            ? 'All mappings were declared confirmed.'
                            : 'Some answers need further review.'}
                        </p>
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
              <section className="panel">
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
            <section className="panel">
              <h2>Deterministic test plan</h2>
              {workspace?.plan ? (
                <>
                  <p>
                    Eligibility is determined by reviewed rules. Unresolved or
                    unreleased checks do not produce passes.
                  </p>
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
                <p>
                  No deterministic plan has been published. Applicable checks
                  and exclusions will appear when their prerequisites are
                  established.
                </p>
              )}
            </section>
            {report ? (
              <Report value={report} api={api} onError={showError} />
            ) : (
              <section className="panel">
                <h2>Evidence report</h2>
                <p>
                  No structured report has been published for this revision.
                  Refreshing reads saved results; it does not start experiments
                  or render a PDF.
                </p>
              </section>
            )}
          </>
        )}
        {busy && (
          <p className="working" role="status">
            {busy}…
          </p>
        )}
      </div>
    </div>
  );
}
