import { Sandbox, type SandboxOpts, type SandboxApiOpts } from 'e2b';
import { z } from 'zod';
import { DEFAULT_POLICY, Digest, Id } from '@siphon/contracts';
import { canonicalJson, sha256 } from './hashing.js';
import {
  E2bInspectionSession,
  type InspectionSession,
} from './inspection-runner.js';
import { E2bSourceSession, type SourceSession } from './source-runner.js';
import {
  E2bValidationSession,
  type ValidationSession,
} from './validation-runner.js';
import { E2bDiagnosticsSession } from './diagnostics-runner.js';
import { E2bPdfSession, type PdfSession } from './pdf-runner.js';
import { E2bConservationSession } from './conservation-runner.js';
import {
  E2bFidelitySession,
  type FidelitySession,
} from './fidelity-session.js';

const ProviderId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export const SandboxRequest = z.strictObject({
  operationId: Id,
  auditId: Id,
  revisionId: Id,
  inputDigest: Digest,
  role: z.enum(['inspection', 'source', 'evaluation', 'pdf']),
  templateId: ProviderId,
  templateEvidenceId: Id,
  lifetimeSeconds: z
    .number()
    .int()
    .min(1)
    .max(DEFAULT_POLICY.sandboxLifetimeSeconds),
});
export type SandboxRequest = z.infer<typeof SandboxRequest>;

export interface SandboxDispatchGate {
  /** Verify immutable template evidence, current fence, credits/time and operation dispatch journal. */
  authorizeCreate(
    request: Readonly<SandboxRequest>,
    requestDigest: string,
  ): Promise<void>;
  /** Persist the provider handle before any source/files/commands can be sent. */
  recordCreated(operationId: string, sandboxId: string): Promise<void>;
  /** Resolve handle ownership from durable server records, including cancelled/deleted jobs. */
  authorizeKill(operationId: string, sandboxId: string): Promise<void>;
  recordTermination(
    operationId: string,
    sandboxId: string,
    outcome: 'killed' | 'not_found',
  ): Promise<void>;
}

export interface SandboxControlPlane {
  create(
    templateId: string,
    options: SandboxOpts,
  ): Promise<{
    sandboxId: string;
    inspectionSession?: InspectionSession;
    sourceSession?: SourceSession;
    validationSession?: ValidationSession;
    diagnosticsSession?: ValidationSession;
    pdfSession?: PdfSession;
    conservationSession?: ValidationSession;
    fidelitySession?: FidelitySession;
  }>;
  kill(sandboxId: string, options: SandboxApiOpts): Promise<boolean>;
}
const sdk: SandboxControlPlane = {
  create: async (template, options) => {
    const sandbox = await Sandbox.create(template, options);
    return {
      sandboxId: sandbox.sandboxId,
      inspectionSession: new E2bInspectionSession(sandbox),
      sourceSession: new E2bSourceSession(sandbox),
      validationSession: new E2bValidationSession(sandbox),
      diagnosticsSession: new E2bDiagnosticsSession(sandbox),
      pdfSession: new E2bPdfSession(sandbox),
      conservationSession: new E2bConservationSession(sandbox),
      fidelitySession: new E2bFidelitySession(sandbox),
    };
  },
  kill: (id, options) => Sandbox.kill(id, options),
};

export class SandboxControlFailure extends Error {
  constructor(
    public readonly code:
      | 'create_unknown'
      | 'handle_unrecorded'
      | 'kill_unknown'
      | 'termination_unrecorded',
    public readonly sandboxId: string | null = null,
  ) {
    super(code);
  }
}

/** Control plane only; no uploaded code is evaluated here. No default admission gate. */
export class E2bClient {
  constructor(
    private readonly apiKey: string,
    private readonly gate: SandboxDispatchGate,
    private readonly provider: SandboxControlPlane = sdk,
  ) {
    if (!apiKey.trim()) throw new Error('E2B credentials are not configured');
  }

  async create(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string }> {
    const { sandboxId } = await this.createSandbox(value, signal);
    return { sandboxId };
  }

  async createInspection(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: InspectionSession }> {
    if (SandboxRequest.parse(value).role !== 'inspection')
      throw new Error('Inspection role is required');
    const result = await this.createSandbox(value, signal);
    if (
      !result.inspectionSession ||
      result.inspectionSession.sandboxId !== result.sandboxId
    )
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.inspectionSession };
  }

  private async createSandbox(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{
    sandboxId: string;
    inspectionSession?: InspectionSession;
    sourceSession?: SourceSession;
    validationSession?: ValidationSession;
    diagnosticsSession?: ValidationSession;
    pdfSession?: PdfSession;
    conservationSession?: ValidationSession;
    fidelitySession?: FidelitySession;
  }> {
    const request = Object.freeze(SandboxRequest.parse(value));
    signal?.throwIfAborted();
    await this.gate.authorizeCreate(
      request,
      await sha256(canonicalJson(request)),
    );
    // If cancelled after admission, no external request occurs; the operation
    // journal remains conservative until the caller reconciles it.
    signal?.throwIfAborted();
    let sandboxId: string;
    let inspectionSession: InspectionSession | undefined;
    let sourceSession: SourceSession | undefined;
    let validationSession: ValidationSession | undefined;
    let diagnosticsSession: ValidationSession | undefined;
    let pdfSession: PdfSession | undefined;
    let conservationSession: ValidationSession | undefined;
    let fidelitySession: FidelitySession | undefined;
    try {
      const result = await this.provider.create(request.templateId, {
        apiKey: this.apiKey,
        retries: 0,
        requestTimeoutMs: 30_000,
        timeoutMs: request.lifetimeSeconds * 1000,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
        allowInternetAccess: false,
        network: { allowPublicTraffic: false },
        lifecycle: { onTimeout: 'kill', autoResume: false },
        envs: {},
        metadata: {
          siphonOperationId: request.operationId,
          siphonRole: request.role,
        },
      });
      sandboxId = ProviderId.parse(result.sandboxId);
      inspectionSession = result.inspectionSession;
      sourceSession = result.sourceSession;
      validationSession = result.validationSession;
      diagnosticsSession = result.diagnosticsSession;
      pdfSession = result.pdfSession;
      conservationSession = result.conservationSession;
      fidelitySession = result.fidelitySession;
    } catch {
      // A missing response is not proof that no billable sandbox exists.
      throw new SandboxControlFailure('create_unknown');
    }
    try {
      await this.gate.recordCreated(request.operationId, sandboxId);
    } catch {
      throw new SandboxControlFailure('handle_unrecorded', sandboxId);
    }
    return {
      sandboxId,
      ...(inspectionSession ? { inspectionSession } : {}),
      ...(sourceSession ? { sourceSession } : {}),
      ...(validationSession ? { validationSession } : {}),
      ...(diagnosticsSession ? { diagnosticsSession } : {}),
      ...(pdfSession ? { pdfSession } : {}),
      ...(conservationSession ? { conservationSession } : {}),
      ...(fidelitySession ? { fidelitySession } : {}),
    };
  }

  async createSource(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: SourceSession }> {
    if (SandboxRequest.parse(value).role !== 'source')
      throw new Error('Source role is required');
    const result = await this.createSandbox(value, signal);
    if (
      !result.sourceSession ||
      result.sourceSession.sandboxId !== result.sandboxId
    )
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.sourceSession };
  }

  async createValidation(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: ValidationSession }> {
    if (SandboxRequest.parse(value).role !== 'evaluation')
      throw new Error('Evaluation role is required');
    const result = await this.createSandbox(value, signal);
    if (
      !result.validationSession ||
      result.validationSession.sandboxId !== result.sandboxId
    )
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.validationSession };
  }

  async createFidelity(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: FidelitySession }> {
    if (SandboxRequest.parse(value).role !== 'evaluation')
      throw new Error('Evaluation role is required');
    const result = await this.createSandbox(value, signal);
    if (
      !result.fidelitySession ||
      result.fidelitySession.sandboxId !== result.sandboxId
    )
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.fidelitySession };
  }

  async createDiagnostics(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: ValidationSession }> {
    if (SandboxRequest.parse(value).role !== 'evaluation')
      throw new Error('Evaluation role is required');
    const result = await this.createSandbox(value, signal);
    if (
      !result.diagnosticsSession ||
      result.diagnosticsSession.sandboxId !== result.sandboxId
    )
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.diagnosticsSession };
  }

  async createPdf(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: PdfSession }> {
    if (SandboxRequest.parse(value).role !== 'pdf')
      throw new Error('PDF role is required');
    const result = await this.createSandbox(value, signal);
    if (!result.pdfSession || result.pdfSession.sandboxId !== result.sandboxId)
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.pdfSession };
  }

  async createConservation(
    value: SandboxRequest,
    signal?: AbortSignal,
  ): Promise<{ sandboxId: string; session: ValidationSession }> {
    if (SandboxRequest.parse(value).role !== 'evaluation')
      throw new Error('Evaluation role is required');
    const result = await this.createSandbox(value, signal);
    if (
      !result.conservationSession ||
      result.conservationSession.sandboxId !== result.sandboxId
    )
      throw new SandboxControlFailure('handle_unrecorded', result.sandboxId);
    return { sandboxId: result.sandboxId, session: result.conservationSession };
  }

  async kill(
    operationId: string,
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<'killed' | 'not_found'> {
    Id.parse(operationId);
    ProviderId.parse(sandboxId);
    signal?.throwIfAborted();
    await this.gate.authorizeKill(operationId, sandboxId);
    signal?.throwIfAborted();
    let outcome: 'killed' | 'not_found';
    try {
      const killed = await this.provider.kill(sandboxId, {
        apiKey: this.apiKey,
        retries: 0,
        requestTimeoutMs: 30_000,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
      if (typeof killed !== 'boolean')
        throw new Error('Invalid provider result');
      outcome = killed ? 'killed' : 'not_found';
    } catch {
      throw new SandboxControlFailure('kill_unknown', sandboxId);
    }
    try {
      await this.gate.recordTermination(operationId, sandboxId, outcome);
    } catch {
      throw new SandboxControlFailure('termination_unrecorded', sandboxId);
    }
    return outcome;
  }
}
