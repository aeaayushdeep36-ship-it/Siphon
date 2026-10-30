import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PdfRenderDocument } from '../packages/contracts/src/index.js';
import { authoredReport } from '../apps/api/test/report-fixture.js';
import { buildPdfDocument } from '../apps/api/src/report-layout.js';

// Fixed authored fixtures only. No uploaded script, file argument, provider or network.
const report = authoredReport();
report.summary +=
  ' Greek symbols ρ, Δt and μ remain literal. <img src="file:///private/no-image.png"/> is text.';
const heat = await buildPdfDocument(report);
const orbit = await buildPdfDocument(authoredReport('orbital_dynamics'));
type Case = { id: string; valid: boolean; payload: string };
const cases: Case[] = [];
function add(id: string, valid: boolean, value: unknown) {
  assert.equal(
    PdfRenderDocument.safeParse(value).success,
    valid,
    `TypeScript acceptance: ${id}`,
  );
  cases.push({ id, valid, payload: JSON.stringify(value) });
}
add('heat', true, heat);
add('orbit', true, orbit);
for (const timestamp of [
  '2000-02-29T00:00:00Z',
  '0000-02-29T00:00:00Z',
  '2026-10-29T00:00:00.123456789Z',
])
  add(`date_${timestamp}`, true, { ...heat, createdAt: timestamp });
for (const timestamp of [
  '2025-02-29T00:00:00Z',
  '1900-02-29T00:00:00Z',
  '2026-04-31T00:00:00Z',
  '2026-10-29T24:00:00Z',
  '2026-10-29T00:00:00+00:00',
])
  add(`invalid_date_${timestamp}`, false, { ...heat, createdAt: timestamp });
for (const [id, block] of Object.entries({
  missing_tone: { kind: 'paragraph', text: 'Literal' },
  invalid_tone: { kind: 'paragraph', text: 'Literal', tone: 'success' },
  image: { kind: 'image', url: 'https://example.org/never-fetch' },
  template: { kind: 'heading', text: 'Title', template: 'execute()' },
  numeric_text: { kind: 'heading', text: 42 },
  empty_text: { kind: 'heading', text: '' },
  oversized_heading: { kind: 'heading', text: 'a'.repeat(301) },
  surrogate: { kind: 'heading', text: '\ud800' },
  control: { kind: 'heading', text: '\u0000' },
}))
  add(id, false, { ...heat, blocks: [block] });
add('unicode_at_boundary', true, { ...heat, title: '🚀'.repeat(200) });
add('unicode_over_boundary', false, { ...heat, title: '🚀'.repeat(201) });
add('extra_root', false, { ...heat, privateKey: 'authored-not-a-real-key' });
add('invalid_id', false, { ...heat, reportId: 'no-id' });
add('invalid_digest', false, { ...heat, reportDigest: 'z'.repeat(64) });
add('numeric_digest', false, { ...heat, reportDigest: 1 });
add('no_blocks', false, { ...heat, blocks: [] });
add('too_many_blocks', false, {
  ...heat,
  blocks: Array.from({ length: 1501 }, () => ({
    kind: 'heading',
    text: 'Title',
  })),
});
add('byte_budget', false, {
  ...heat,
  blocks: Array.from({ length: 40 }, () => ({
    kind: 'paragraph',
    text: 'a'.repeat(16000),
    tone: 'normal',
  })),
});
for (const [id, mutate] of Object.entries({
  boolean_coordinate: (series: Record<string, unknown>) => {
    series.points = [{ x: true, y: 0 }];
  },
  numeric_string: (series: Record<string, unknown>) => {
    series.points = [{ x: '0', y: 0 }];
  },
  integer_string: (series: Record<string, unknown>) => {
    series.originalPointCount = '3';
  },
  boolean_count: (series: Record<string, unknown>) => {
    series.originalPointCount = true;
  },
  unsafe_count: (series: Record<string, unknown>) => {
    series.originalPointCount = Number.MAX_SAFE_INTEGER + 1;
  },
  fractional_count: (series: Record<string, unknown>) => {
    series.originalPointCount = 3.1;
  },
  false_sampling: (series: Record<string, unknown>) => {
    series.originalPointCount = 1;
  },
  empty_points: (series: Record<string, unknown>) => {
    series.points = [];
  },
  oversized_points: (series: Record<string, unknown>) => {
    series.originalPointCount = 2001;
    series.points = Array.from({ length: 2001 }, () => ({ x: 0, y: 0 }));
  },
})) {
  const plot = structuredClone(report.plots[0]!);
  mutate(plot.series[0]!);
  add(id, false, { ...heat, blocks: [{ kind: 'plot', plot }] });
}
const fractional = structuredClone(report.plots[0]!);
fractional.series[0]!.originalPointCount = 3.0;
add('json_integer_float', true, {
  ...heat,
  blocks: [{ kind: 'plot', plot: fractional }],
});
const extreme = structuredClone(report.plots[0]!);
extreme.series[0]!.points = [
  { x: -1e308, y: 0 },
  { x: 1e308, y: 5e-324 },
];
add('extreme_finite_points', true, {
  ...heat,
  blocks: [{ kind: 'plot', plot: extreme }],
});

const python = `
import base64,io,json,sys
from pypdf import PdfReader
from siphon_science.pdf_models import parse_pdf_document
from siphon_science.pdf_render import render_pdf
assert sys.version_info[:2] == (3,11), 'Python 3.11 required'
request=json.loads(sys.stdin.buffer.read().decode('utf-8',errors='strict'))
roundtrips=[]
for case in request['cases']:
    try:
        parsed=parse_pdf_document(case['payload'].encode('utf-8'))
        accepted=True
        roundtrips.append({'id':case['id'],'document':parsed.model_dump(by_alias=True)})
    except (ValueError,TypeError) as error:
        accepted=False
        if case['valid']:
            details=[(issue['loc'],issue['type']) for issue in error.errors(include_input=False)] if hasattr(error,'errors') else type(error).__name__
            raise AssertionError('Python rejected authored '+case['id']+': '+str(details)) from None
    assert accepted == case['valid'], 'Python acceptance mismatch: '+case['id']
pdf=render_pdf(request['document'].encode('utf-8'))
reader=PdfReader(io.BytesIO(pdf))
text=' '.join(' '.join(page.extract_text() for page in reader.pages).split())
for literal in request['requiredText']:
    assert ' '.join(literal.split()) in text, 'Rendered report lost required text'
assert all('/Annots' not in page for page in reader.pages), 'Unexpected PDF active annotations'
assert '/JavaScript' not in reader.trailer['/Root'], 'Unexpected PDF JavaScript'
assert render_pdf(request['document'].encode('utf-8')) == pdf, 'PDF is not deterministic'
render_pdf(request['extremeDocument'].encode('utf-8'))
print(json.dumps({'cases':len(request['cases']),'pages':len(reader.pages),'bytes':len(pdf),'roundtrips':roundtrips,'pdfBase64':base64.b64encode(pdf).decode('ascii')},allow_nan=False))
`;
const requiredText = [
  report.reportId,
  report.revisionId,
  heat.reportDigest,
  report.title,
  'ρ, Δt and μ',
  'file:///private/no-image.png',
  'energy_drift = 0.5 J',
  'Target: 1 J',
  'Absolute uncertainty bound: 0 J',
  'Conservative interval: [0.5, 0.5] J',
  'X: Time [s]',
  'Y: Energy drift [J]',
  '3 displayed / 3 original points',
  'Possible causes - hypotheses',
  report.narrative.hypotheses[0]!.verification,
  report.narrative.recommendations[0]!.validation,
  report.references[0]!.url,
  report.limitations[1]!,
];
const raw = execFileSync(
  process.env.SIPHON_PYTHON ?? 'python',
  ['-c', python],
  {
    cwd: fileURLToPath(new URL('../packages/science/', import.meta.url)),
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    input: JSON.stringify({
      cases,
      document: JSON.stringify(heat),
      requiredText,
      extremeDocument: JSON.stringify({
        ...heat,
        blocks: [{ kind: 'plot', plot: extreme }],
      }),
    }),
  },
);
const result = z
  .strictObject({
    cases: z.number().int().positive(),
    pages: z.number().int().positive().max(60),
    bytes: z
      .number()
      .int()
      .positive()
      .max(5 * 1024 * 1024),
    pdfBase64: z.string(),
    roundtrips: z.array(
      z.strictObject({ id: z.string(), document: z.unknown() }),
    ),
  })
  .parse(JSON.parse(raw));
for (const item of result.roundtrips) {
  const original = cases.find((value) => value.id === item.id);
  assert(original?.valid, 'Unexpected Python round-trip identity');
  assert.deepEqual(
    PdfRenderDocument.parse(item.document),
    JSON.parse(original.payload),
    `Python serialization changed ${item.id}`,
  );
}
assert.equal(
  result.roundtrips.length,
  cases.filter((item) => item.valid).length,
);
const output = new URL(
  '../output/pdf/siphon-authored-report.pdf',
  import.meta.url,
);
mkdirSync(new URL('./', output), { recursive: true });
const bytes = Buffer.from(result.pdfBase64, 'base64');
assert.equal(bytes.length, result.bytes);
assert.equal(bytes.subarray(0, 5).toString('ascii'), '%PDF-');
writeFileSync(output, bytes);
console.log(
  `Verified ${result.cases} Zod/Pydantic PDF layout cases, report text/precision/provenance, escaped markup, extreme plot scaling and deterministic ${result.pages}-page/${result.bytes}-byte authored PDF: ${fileURLToPath(output)}`,
);
