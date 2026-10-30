import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from '@firebase/rules-unit-testing';
import {
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from 'firebase/firestore';

// Refuse real project/service endpoints. The Firebase CLI must start this local
// emulator with --project demo-siphon-rules; no application credentials are read.
const endpoint = process.env.FIRESTORE_EMULATOR_HOST;
if (!endpoint || !/^127\.0\.0\.1:\d{1,5}$/.test(endpoint))
  throw new Error('A loopback Firestore emulator is required');
const port = Number(endpoint.split(':')[1]);
if (port < 1024 || port > 65535) throw new Error('Invalid emulator port');
const environment = await initializeTestEnvironment({
  projectId: 'demo-siphon-rules',
  firestore: {
    host: '127.0.0.1',
    port,
    rules: readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8'),
  },
});
let passed = 0;
const scenario = async (_name, callback) => {
  await callback();
  passed++;
};
const alice = environment
  .authenticatedContext('alice', {
    firebase: { sign_in_provider: 'google.com' },
  })
  .firestore();
const bob = environment
  .authenticatedContext('bob', { firebase: { sign_in_provider: 'google.com' } })
  .firestore();
const anonymous = environment.unauthenticatedContext().firestore();
const password = environment
  .authenticatedContext('alice', { firebase: { sign_in_provider: 'password' } })
  .firestore();
const read = (db, path) => getDoc(doc(db, path));
const current = Timestamp.fromMillis(Date.now());
const future = Timestamp.fromMillis(Date.now() + 86400000);
const past = Timestamp.fromMillis(Date.now() - 86400000);
try {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const uid of ['alice', 'bob'])
      await setDoc(doc(db, `testers/${uid}`), { active: true });
    for (const [auditId, uid] of [
      ['audit-a', 'alice'],
      ['audit-b', 'bob'],
    ]) {
      await setDoc(doc(db, `audits/${auditId}`), {
        ownerUid: uid,
        deletionRequestedAt: null,
        updatedAt: current,
      });
      const identity = { ownerUid: uid, auditId, revisionId: 'revision' };
      const base = `audits/${auditId}/revisions/revision`;
      await setDoc(doc(db, base), identity);
      await setDoc(doc(db, `${base}/questions/current`), {
        ownerUid: uid,
        questionSet: { auditId, revisionId: 'revision' },
      });
      await setDoc(doc(db, `${base}/events/000001`), {
        auditId,
        revisionId: 'revision',
        sequence: 1,
      });
      for (const kind of ['plans', 'evidence', 'reports'])
        await setDoc(doc(db, `${base}/${kind}/visible`), {
          ...identity,
          expiresAt: future,
        });
      await setDoc(doc(db, `${base}/reports/expired`), {
        ...identity,
        expiresAt: past,
      });
      await setDoc(doc(db, `${base}/reports/wrong-owner`), {
        ...identity,
        ownerUid: 'mallory',
        expiresAt: future,
      });
      for (const kind of [
        'context',
        'numericValidations',
        'numericDiagnostics',
        'inspection',
      ])
        await setDoc(doc(db, `${base}/${kind}/private`), identity);
      await setDoc(doc(db, `audits/${auditId}/artifacts/private`), identity);
    }
    for (const collectionId of [
      'budgets',
      'operations',
      'reservations',
      'configuration',
      'requests',
      'rateWindows',
      'maintenanceJobs',
      'sandboxJobs',
      'sandboxHandles',
      'validationCandidates',
      'diagnosticCandidates',
      'sourceExecutionApprovals',
      'validationExecutions',
      'diagnosticExecutions',
      'stageJobs',
    ])
      await setDoc(doc(db, `${collectionId}/private`), {
        ownerUid: 'alice',
        secret: 'authored-test-marker',
      });
  });
  await scenario('owner reads display documents', async () => {
    for (const path of [
      'audits/audit-a',
      'audits/audit-a/revisions/revision',
      'audits/audit-a/revisions/revision/questions/current',
      'audits/audit-a/revisions/revision/events/000001',
      ...['plans', 'evidence', 'reports'].map(
        (kind) => `audits/audit-a/revisions/revision/${kind}/visible`,
      ),
    ])
      await assertSucceeds(read(alice, path));
  });
  await scenario(
    'cross-owner, anonymous and non-Google reads fail',
    async () => {
      for (const db of [bob, anonymous, password])
        for (const path of [
          'audits/audit-a',
          'audits/audit-a/revisions/revision/questions/current',
        ])
          await assertFails(read(db, path));
    },
  );
  await scenario(
    'bounded owner history succeeds but broad and unbounded queries fail',
    async () => {
      const base = collection(alice, 'audits');
      const filters = [
        where('ownerUid', '==', 'alice'),
        where('deletionRequestedAt', '==', null),
      ];
      const history = await assertSucceeds(
        getDocs(
          query(base, ...filters, orderBy('updatedAt', 'desc'), limit(20)),
        ),
      );
      assert.equal(history.size, 1);
      await assertFails(getDocs(query(base, limit(20))));
      await assertFails(getDocs(query(base, ...filters)));
      await assertFails(getDocs(query(base, ...filters, limit(21))));
    },
  );
  await scenario('bounded owner event query succeeds', async () => {
    await assertSucceeds(
      getDocs(
        query(
          collection(alice, 'audits/audit-a/revisions/revision/events'),
          where('auditId', '==', 'audit-a'),
          where('revisionId', '==', 'revision'),
          orderBy('sequence'),
          limit(50),
        ),
      ),
    );
    await assertFails(
      getDocs(
        query(
          collection(alice, 'audits/audit-a/revisions/revision/events'),
          limit(51),
        ),
      ),
    );
  });
  await scenario('expired or misbound reports fail', async () => {
    await assertFails(
      read(alice, 'audits/audit-a/revisions/revision/reports/expired'),
    );
    await assertFails(
      read(alice, 'audits/audit-a/revisions/revision/reports/wrong-owner'),
    );
  });
  await scenario(
    'private nested collections and artifacts fail even for owner',
    async () => {
      for (const kind of [
        'context',
        'numericValidations',
        'numericDiagnostics',
        'inspection',
      ])
        await assertFails(
          read(alice, `audits/audit-a/revisions/revision/${kind}/private`),
        );
      await assertFails(read(alice, 'audits/audit-a/artifacts/private'));
    },
  );
  await scenario('all privileged collections fail even for owner', async () => {
    for (const collectionId of [
      'testers',
      'budgets',
      'operations',
      'reservations',
      'configuration',
      'requests',
      'rateWindows',
      'maintenanceJobs',
      'sandboxJobs',
      'sandboxHandles',
      'validationCandidates',
      'diagnosticCandidates',
      'sourceExecutionApprovals',
      'validationExecutions',
      'diagnosticExecutions',
      'stageJobs',
    ])
      await assertFails(
        read(
          alice,
          `${collectionId}/${collectionId === 'testers' ? 'alice' : 'private'}`,
        ),
      );
  });
  await scenario('all direct browser writes fail', async () => {
    for (const path of [
      'audits/audit-a',
      'audits/new',
      'audits/audit-a/revisions/revision',
      'audits/audit-a/revisions/revision/reports/forged',
      'testers/alice',
      'budgets/private',
      'unknown/path',
    ])
      await assertFails(setDoc(doc(alice, path), { ownerUid: 'alice' }));
  });
  await scenario(
    'tombstone immediately denies existing revision/report reads',
    async () => {
      await environment.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'audits/audit-a'), {
          ownerUid: 'alice',
          deletionRequestedAt: current,
        });
      });
      await assertFails(read(alice, 'audits/audit-a'));
      await assertFails(read(alice, 'audits/audit-a/revisions/revision'));
      await assertFails(
        read(alice, 'audits/audit-a/revisions/revision/reports/visible'),
      );
    },
  );
  await scenario(
    'invitation revocation denies reads despite valid identity',
    async () => {
      await environment.withSecurityRulesDisabled(async (context) => {
        await setDoc(doc(context.firestore(), 'testers/bob'), {
          active: false,
        });
      });
      await assertFails(read(bob, 'audits/audit-b'));
    },
  );
  process.stdout.write(
    `Verified ${passed} Firestore emulator rule scenarios.\n`,
  );
} finally {
  await environment.cleanup();
}
