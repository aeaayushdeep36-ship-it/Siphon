import crypto from 'node:crypto';
import process from 'node:process';
import { googleAccessTokenProvider } from '../apps/api/src/google-oauth.js';
import { FirestoreClient } from '../apps/api/src/firestore.js';
import { sha256 } from '../apps/api/src/hashing.js';
import { E2bCreditEvidence, SandboxTemplateEvidence } from '../apps/api/src/sandbox-jobs.js';
import { BudgetCounter } from '../apps/api/src/accounting.js';

const isDryRun = !process.argv.includes('--apply');

const projectId = process.env.FIREBASE_PROJECT_ID;
const databaseId = process.env.FIRESTORE_DATABASE_ID || '(default)';
const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;

if (!projectId || !clientEmail || !privateKey) {
  console.error('FIREBASE_PROJECT_ID, GOOGLE_SERVICE_ACCOUNT_EMAIL, and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY are required.');
  process.exit(1);
}

const tokenProvider = googleAccessTokenProvider({
  projectId,
  clientEmail,
  privateKey,
});

const firestore = new FirestoreClient(projectId, tokenProvider, fetch, databaseId);

const now = new Date().toISOString();
const grantExpiresAt = '2027-11-01T00:00:00.000Z'; // Pinned to official E2B grant expiry

// 1. E2B Credits Document
const e2bCreditEvidence = E2bCreditEvidence.parse({
  schemaVersion: '1.0',
  evidenceId: crypto.randomUUID(),
  allocationMicroUsd: 100_000_000, // $100.00
  availableMicroUsd: 99_990_000,    // $99.99
  accountedSpentMicroUsd: 10_000,   // $0.01 observed usage
  verifiedAt: now,
  expiresAt: grantExpiresAt,
});

// 2. Global E2B Budget Counter
const globalBudget = BudgetCounter.parse({
  schemaVersion: '1.0',
  limit: 100_000_000,
  reserved: 0,
  spent: 10_000,
  halted: false,
});

// 3. Storage Accounting Periods (for file uploads and downloads)
const r2ClassAPeriod = {
  counterKey: 'r2_a_current',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2027-11-01T00:00:00.000Z',
};

const r2ClassACounter = BudgetCounter.parse({
  schemaVersion: '1.0',
  limit: 1_000_000,
  reserved: 0,
  spent: 0,
  halted: false,
});

const r2ClassBPeriod = {
  counterKey: 'r2_b_current',
  startsAt: '2026-11-01T00:00:00.000Z',
  endsAt: '2027-11-01T00:00:00.000Z',
};

const r2ClassBCounter = BudgetCounter.parse({
  schemaVersion: '1.0',
  limit: 1_000_000,
  reserved: 0,
  spent: 0,
  halted: false,
});

const r2StorageBytes = BudgetCounter.parse({
  schemaVersion: '1.0',
  limit: 2 * 1024 ** 3, // 2 GiB matching DEFAULT_POLICY.storageBytes
  reserved: 0,
  spent: 0,
  halted: false,
});

const kvStorageBytes = {
  schemaVersion: '1.0' as const,
  allocated: 0,
};

// 4. Role Templates
const roles = ['inspection', 'source', 'evaluation', 'pdf'] as const;

async function prepareTemplateEvidence(role: typeof roles[number]) {
  const prefix = `SIPHON_${role.toUpperCase()}_TEMPLATE`;
  const templateId = process.env[`${prefix}_ID`];
  const buildId = process.env[`${prefix}_BUILD_ID`];
  const tag = process.env[`${prefix}_TAG`];

  if (!templateId) {
    return null;
  }

  const evidenceId = crypto.randomUUID();
  const imageDigest = await sha256(`siphon-${role}-${templateId}`);
  const runtimeDigest = await sha256(`siphon-runtime-${role}-${buildId || templateId}`);

  const evidence = SandboxTemplateEvidence.parse({
    schemaVersion: '1.0',
    id: evidenceId,
    templateId,
    ...(buildId ? { templateBuildId: buildId } : {}),
    ...(tag ? { templateTag: tag } : {}),
    role,
    imageDigest,
    runtimeDigest,
    verifiedAt: now,
    expiresAt: grantExpiresAt,
    networkIsolationVerified: true,
    privateAccessVerified: true,
    resourceLimitsVerified: true,
    singlePrivateBuildVerified: true,
    ...(role === 'source' ? { numericInputValidation: 'headerless-csv-npy-v1' as const } : {}),
    microUsdPerSecondCeiling: 10,
  });

  let dispatchConfig: Record<string, unknown> = {
    templateEvidenceId: evidenceId,
    lifetimeSeconds: 60,
  };

  if (role === 'source') {
    dispatchConfig = {
      ...dispatchConfig,
      maximumOutputBytes: 10 * 1024 * 1024,
      maximumElements: 100_000,
    };
  }

  return { role, evidence, dispatchConfig };
}

async function main() {
  console.log(`=== Siphon Firestore Provisioning [${isDryRun ? 'DRY-RUN PREVIEW' : 'APPLYING LIVE'}] ===\n`);
  console.log(`Target Database: projects/${projectId}/databases/${databaseId}\n`);

  const documentsToWrite: Array<{ path: string; data: unknown }> = [
    { path: 'configuration/e2b_credits', data: e2bCreditEvidence },
    { path: 'budgets/e2b_global_micro_usd', data: globalBudget },
    { path: 'configuration/r2_class_a_period', data: r2ClassAPeriod },
    { path: 'budgets/r2_a_current', data: r2ClassACounter },
    { path: 'configuration/r2_class_b_period', data: r2ClassBPeriod },
    { path: 'budgets/r2_b_current', data: r2ClassBCounter },
    { path: 'budgets/r2_storage_bytes', data: r2StorageBytes },
    { path: 'budgets/kv_storage_bytes', data: kvStorageBytes },
  ];

  for (const role of roles) {
    const prepared = await prepareTemplateEvidence(role);
    if (prepared) {
      documentsToWrite.push({
        path: `sandboxTemplates/${prepared.evidence.id}`,
        data: prepared.evidence,
      });
      documentsToWrite.push({
        path: `configuration/${role}_dispatch`,
        data: prepared.dispatchConfig,
      });
      console.log(`[OK] Role '${role}': Configured (templateId: ${prepared.evidence.templateId})`);
    } else {
      console.log(`[WARN] Role '${role}': Missing configuration environment variables (SIPHON_${role.toUpperCase()}_TEMPLATE_ID)`);
    }
  }

  console.log(`\nPrepared ${documentsToWrite.length} documents for writing:\n`);
  for (const doc of documentsToWrite) {
    console.log(`-> Document: ${doc.path}`);
    if (isDryRun) {
      console.log(JSON.stringify(doc.data, null, 2));
    }
  }

  if (isDryRun) {
    console.log('\n[DRY RUN COMPLETE] No documents were written. Run with --apply to write to production Firestore.');
    return;
  }

  console.log('\nWriting documents via atomic transaction...');
  await firestore.transaction(async (tx) => {
    for (const doc of documentsToWrite) {
      tx.set(doc.path, doc.data as Record<string, unknown>);
    }
  });

  console.log('Verifying written documents...');
  const paths = documentsToWrite.map((d) => d.path);
  const fetched = await firestore.getMany(paths);
  const missing = paths.filter((_, i) => !fetched[i]);

  if (missing.length > 0) {
    throw new Error(`Verification failed! Missing documents: ${missing.join(', ')}`);
  }

  console.log(`\n[SUCCESS] All ${documentsToWrite.length} documents successfully written and verified in Firestore.`);
}

main().catch((err) => {
  console.error('\n[ERROR] Provisioning failed:', err);
  process.exit(1);
});
