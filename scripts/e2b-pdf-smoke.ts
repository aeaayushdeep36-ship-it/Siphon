import { Sandbox, Template } from 'e2b';
import { E2bPdfSession, PdfRunner } from '../apps/api/src/pdf-runner.js';
import { buildPdfDocument } from '../apps/api/src/report-layout.js';
import { authoredReport } from '../apps/api/test/report-fixture.js';

const templateId = process.env.SIPHON_PDF_TEMPLATE_ID;
const templateBuildId = process.env.SIPHON_PDF_TEMPLATE_BUILD_ID;
const templateTag = process.env.SIPHON_PDF_TEMPLATE_TAG;
const apiKey = process.env.E2B_API_KEY;
if (
  !templateId ||
  !/^[a-zA-Z0-9_-]{1,128}$/.test(templateId) ||
  !templateBuildId ||
  !/^[a-f0-9-]{36}$/.test(templateBuildId) ||
  !templateTag ||
  !/^siphon-[a-f0-9]{32}$/.test(templateTag) ||
  !apiKey
)
  throw new Error('Provide the PDF template ID, build ID, tag and E2B_API_KEY');

const tags = await Template.getTags(templateId, { apiKey, retries: 0 });
if (tags.find((item) => item.tag === templateTag)?.buildId !== templateBuildId)
  throw new Error('Pinned PDF smoke template build mismatch');

// The report is an authored test fixture. These gates are not production authorization.
const document = await buildPdfDocument(authoredReport());
let sandbox: Sandbox | undefined;
try {
  sandbox = await Sandbox.create(`${templateId}:${templateTag}`, {
    timeoutMs: 60000,
    allowInternetAccess: false,
    network: { allowPublicTraffic: false },
    lifecycle: { onTimeout: 'kill', autoResume: false },
    retries: 0,
  });
  const runner = new PdfRunner(new E2bPdfSession(sandbox), {
    async claim() {},
    async authorizeResult() {},
  });
  const result = await runner.run(document);
  console.log(
    JSON.stringify({ bytes: result.bytes.length, receiptVerified: true }),
  );
} finally {
  if (sandbox)
    console.log(JSON.stringify({ terminated: await sandbox.kill() }));
}
