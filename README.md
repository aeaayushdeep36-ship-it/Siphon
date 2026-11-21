# Siphon

Siphon is a work-in-progress tool for reviewing scientific simulations written in Python. The first supported domains are heat diffusion and gravitational orbital dynamics. It is designed to make a review traceable: users choose a domain, provide existing source and supporting files, confirm relevant scientific context, then inspect the checks, evidence, assumptions, and limitations.

> **Project status (2026-11-12):** the React frontend and Cloudflare Worker API are deployed. Firebase identity verification and private API access are configured. The API is enabled; the Cloudflare inspection workflow remains disabled while E2B accounting, runtime approvals and Cloudflare Free workload fit are verified. Signed-in private history lists the existing synthetic heat draft, but opening or refreshing its saved workspace still returns `storage_unavailable`. A complete user audit has not been demonstrated in production. Local fixtures and provider smoke checks are not completed audits.

[Open the hosted frontend](https://siphon-simulation-audit.pages.dev) · [View the current integration branch](https://github.com/aeaayushdeep36-ship-it/Siphon/tree/coordination/shared-baseline-2026-11-11) · [Product requirements](docs/PRODUCT_REQUIREMENTS.md)

## What Siphon is designed to do

- Review existing Python source; it does not generate replacement simulations or automatically edit user code.
- Use AI to help interpret code and explain evidence. Reviewed deterministic rules decide which scientific checks apply and how measured evidence is evaluated.
- Preserve unknowns, user-confirmed assumptions, source identity, revision history, and provenance.
- Show checks that ran and checks that were excluded, with reasons. Missing evidence is not a pass.
- Keep numerical findings scoped to their assumptions and accuracy policies. Siphon does not issue a global correctness score or certify a model's scientific validity.
- Run uploaded source only in fresh isolated E2B sandboxes when that workflow is enabled. Uploaded code must never be executed on a developer's machine or in a trusted evaluator.

## Current implementation status

The repository contains a React audit console, a Cloudflare Worker API, shared TypeScript contracts, and a Python scientific package. Authentication, private audit/revision storage, uploads, readiness and inspection stages, context and adapter proposals, domain questions, deterministic eligibility, scientific calculations, evidence/report components, accounting controls, and PDF rendering are present to varying degrees.

The repository implements resumable workflow stages for inspection, context, scientific planning/evaluation, reporting, PDF creation, and publication, backed by shared contracts and Python scientific routines. A refreshed source template now contains the headerless CSV/NPY validator; live authored fixtures accepted valid files, rejected malformed files before source execution, and a heat-from-CSV simulation passed the released `H_ENERGY` check. This template has not been approved in production Firestore, so the Worker continues to block numeric uploads until an approved template record exists. Production execution remains gated off; these fixture checks do not demonstrate a complete production audit.

The React app includes the supplied dark landing page and audit console design. Its production bundle points to the Cloudflare Worker API, and production-origin CORS preflight and unauthenticated API responses have been verified. The earlier [design/website-preview.html](design/website-preview.html) remains a standalone visual concept and is not the running React app. The production frontend is at [siphon-simulation-audit.pages.dev](https://siphon-simulation-audit.pages.dev); the API is at [siphon-api.lookingforit.workers.dev](https://siphon-api.lookingforit.workers.dev). Firebase sign-in succeeded in Chrome and signed-in private history rendered the existing synthetic draft. Opening that draft and refreshing its persisted workspace returned `storage_unavailable`; the cause remains unresolved. No complete authenticated browser audit is established.

## Technology

- **Web:** React, TypeScript, Vite, Firebase Authentication
- **API:** Hono on Cloudflare Workers; Cloudflare Workflows and private KV are provisioned, with workflow execution currently disabled
- **Data and contracts:** Firebase/Firestore and shared Zod schemas in `packages/contracts`
- **Scientific routines:** Python 3.11, NumPy, Pydantic, pytest, Ruff, and mypy in `packages/science`
- **AI provider:** Groq Chat Completions; the configured model is selected through `SIPHON_AI_MODEL` (currently `qwen/qwen3.8-27b`). Model, endpoint, limits, and reasoning settings are configurable. Keep within the configured free-tier quotas and do not assume the provider's free availability or limits are permanent. No paid fallback is configured.

## Repository layout

```text
apps/
  api/                 Cloudflare Worker, API, and provider integrations
  web/                 React + Vite client
packages/
  contracts/           Shared Zod contracts and schemas
  science/             Python inspection, validation, numerical, and PDF modules
infra/
  firebase/            Firestore rules, indexes, and rule checks
docs/                  Product, architecture, security, design, and testing records
design/                Standalone design previews
scripts/               Build, parity, schema, and verification scripts
tests/postman/         Read-only API collection
```

## Requirements

- Node.js **24.x** and npm
- Python **3.11** for scientific verification and cross-language parity commands
- A Groq API key only for the optional live provider smoke check
- Firebase, Cloudflare, and E2B credentials only for the service workflows that need them; these are not included in the repository

## Local setup

Run these commands from the repository root.

### Install JavaScript dependencies

```powershell
npm ci
```

### Prepare the Python verification environment

The Python package uses pinned developer requirements. The root science scripts automatically use `.tools/science-venv` when it exists.

```powershell
py -3.11 -m venv .tools/science-venv
.\.tools\science-venv\Scripts\python.exe -m pip install -r packages/science/requirements-dev.txt
```

On macOS or Linux, use the environment's `bin/python` instead:

```sh
python3.11 -m venv .tools/science-venv
.tools/science-venv/bin/python -m pip install -r packages/science/requirements-dev.txt
```

### Configure local API variables

Create the ignored local variables file if it does not already exist:

```powershell
if (-not (Test-Path apps/api/.dev.vars)) { Copy-Item apps/api/.dev.vars.example apps/api/.dev.vars }
```

Edit `apps/api/.dev.vars` locally. Put `GROQ_API_KEY` there; keep it out of source code, the frontend, logs, chat, and tracked examples. The example intentionally leaves secrets empty and keeps `SIPHON_API_ENABLED` and `SIPHON_INSPECTION_WORKFLOW_ENABLED` set to `false`. Do not enable hosted routes or workflows until their configuration and safety gates have been checked.

`SIPHON_AI_MODEL`, `SIPHON_AI_ENDPOINT`, reasoning, request/response limits, and request/token quotas are settings in the example file. The request-byte screen is separate from token accounting; it is not an exact tokenizer. The application settings are safeguards, not a promise of Groq availability or account capacity.

### Configure the web client

```powershell
if (-not (Test-Path apps/web/.env.local)) { Copy-Item apps/web/.env.example apps/web/.env.local }
```

Fill in the public Firebase web configuration in `apps/web/.env.local`:

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_API_BASE_URL` (the API origin only; omit `/api/v1`)

These `VITE_*` values are delivered to the browser and must contain **public web configuration only**. Never put a Groq key, Firebase service-account key, Cloudflare token, or E2B key in a `VITE_*` variable. If Firebase web settings are absent, the sign-in screen reports that configuration is unavailable.

Start the Vite client:

```powershell
npm run dev --workspace @siphon/web
```

This starts the web client only. The local `apps/api/.dev.vars` template keeps the API and inspection workflow disabled by default. Production has the API enabled, but its inspection workflow is still gated off.

## Verification commands

Run only the checks relevant to your change. Python verification expects Python 3.11 and the environment described above.

```sh
npm test                         # TypeScript unit tests
npm run lint                     # ESLint and Prettier checks
npm run typecheck                # TypeScript type checks
npm run verify:science           # Python dependency, Ruff, mypy, and pytest checks
npm run build                    # Type checks, schemas, Worker dry run, and web build
npm run test:worker-runtime      # Local Worker runtime check with disabled services
npm run test:rules               # Firestore rules/emulator verification
npm run test:report-pdf          # PDF/report fixture and parity checks
```

Cross-language parity checks are also available as `npm run test:python-model-parity`, `npm run test:inspection-parity`, `npm run test:fidelity-parity`, `npm run test:evidence-parity`, `npm run test:diagnostics-parity`, `npm run test:source-job-parity`, `npm run test:adapter-parity`, and `npm run test:inspection-job-parity`.

The science and parity commands use `SIPHON_PYTHON` when set, otherwise the project virtual environment in `.tools/science-venv` when present, and finally `python` from the system path. Use Python 3.11 and the pinned dependencies above.

The live Groq check sends one tiny synthetic strict-JSON request; it does not send project source or run an audit. Before using it, confirm the key is on Groq's Free plan and review current limits and data settings. From PowerShell:

```powershell
$env:SIPHON_GROQ_LIVE_SMOKE = 'I-confirm-this-key-is-on-Groq-Free'
npm run test:groq-live
```

The script reads `GROQ_API_KEY` from `apps/api/.dev.vars` only after that acknowledgement is set. The request consumes provider quota. See [docs/TESTING.md](docs/TESTING.md) for what the smoke check verifies and what it does not.

To check configured E2B roles without creating or billing a sandbox, set
`E2B_API_KEY` and each available role's `SIPHON_{ROLE}_TEMPLATE_ID`,
`SIPHON_{ROLE}_TEMPLATE_BUILD_ID`, and `SIPHON_{ROLE}_TEMPLATE_TAG`, then run:

```powershell
npm run audit:e2b-templates
```

The audit checks current provider visibility, build count, current build ID,
and the tag mapping. It reads provider metadata only; it does not certify
network isolation, runtime safety, resource limits, or a production approval.

## Secrets and service configuration

- **Local Groq key:** ignored `apps/api/.dev.vars` as `GROQ_API_KEY="..."`.
- **Hosted Groq key:** stored as a Cloudflare Worker secret. Wrangler secret changes create Worker versions; keep the workflow flag disabled until its runtime gates are verified.
- **Firebase service-account credentials:** backend-only local variables or managed secret configuration; never frontend variables or uploaded-code sandboxes.
- **E2B key:** backend-only. User code must execute in a fresh isolated sandbox with the documented network, time, and resource restrictions.
- **E2B endpoint:** optionally set the server-owned `E2B_API_URL` to a clean HTTPS origin (no credentials, path, query or fragment). Leave it unset for `https://api.e2b.app`. Runtime metadata/tag verification, creation, termination and the read-only template audit use the same origin. Do not change the endpoint while unresolved sandbox handles exist; reconcile/terminate them against their original provider first. A custom endpoint is a trusted operator choice, never upload/user/model input.
- **Firebase browser settings:** public `VITE_FIREBASE_*` configuration only.

The API is available at its `workers.dev` endpoint; the production inspection workflow is disabled. The private KV namespace, Firebase service credentials, E2B/Groq keys, allowed origin, and explicit model limits are configured. This is not proof that all services are ready for user audits: verify Firebase browser sign-in, Firestore access/rules, E2B template approvals and reconciled credits, sandbox isolation, and actual end-to-end audit behavior before enabling workflow execution. Preserve zero out-of-pocket spending; do not enable paid overages or assume a free tier guarantees a zero invoice.

Cloudflare Workflows on Workers Free currently have finite CPU, external-subrequest, step, and storage limits, and step/storage billing is active. Measure a complete audit against the [current limits](https://developers.cloudflare.com/workflows/reference/limits/) and [pricing](https://developers.cloudflare.com/workflows/reference/pricing/) before enabling production execution.

## Further documentation

- [Project context and remaining work](docs/PROJECT_CONTEXT.md)
- [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Database](docs/DATABASE.md)
- [Design and interaction specification](docs/DESIGN_SYSTEM.md)
- [Testing and verification history](docs/TESTING.md)
- [Code style](docs/CODE_STYLE.md)

## License

See [LICENSE](LICENSE).
