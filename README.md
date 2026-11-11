# Siphon

Siphon is a work-in-progress application for reviewing scientific simulations written in Python. It focuses on two domains: **heat diffusion** and **gravitational orbital dynamics**. Its goal is to help a researcher understand which checks apply to a simulation, what the evidence supports, and which assumptions or uncertainties remain.

> **Project status:** Siphon is under active development. The frontend and API have been deployed, but the hosted audit workflow is currently disabled while execution, service limits, and sandbox approvals are being verified. A complete production audit has not yet been demonstrated.

[Open the hosted frontend](https://siphon-simulation-audit.pages.dev) · [View the current integration branch](https://github.com/aeaayushdeep36-ship-it/Siphon/tree/coordination/shared-baseline-2026-11-11) · [Product requirements](docs/PRODUCT_REQUIREMENTS.md)

## What Siphon does

Siphon is designed to review an existing simulation rather than replace it. A user selects a domain, supplies Python source and any supporting data, and confirms the scientific context needed for a meaningful review. The application then works toward a report that records applicable checks, evidence, assumptions, and limitations.

- **Heat diffusion:** review relevant properties of a thermal simulation, including supported energy checks where the necessary inputs are available.
- **Orbital dynamics:** review supported conservation checks for gravitational simulations when their assumptions and inputs are established.
- **Traceable evidence:** retain the source identity, revision, inputs and context associated with a review.
- **Clear limits:** show missing information and excluded checks; missing evidence is not a passing result.
- **Assisted interpretation:** AI helps interpret code and explain evidence. Reviewed deterministic scientific code controls check selection and numerical verdicts.

Siphon does not automatically repair or rewrite the user's simulation, and its results do not certify that a model is universally correct.

## How the project fits together

1. The React frontend provides the landing page, sign-in and audit workspace.
2. A Cloudflare Worker API handles authenticated requests and coordinates audit stages.
3. Firebase Authentication and Firestore support identity and private audit records.
4. E2B sandboxes are intended to run uploaded Python in isolated environments; trusted scientific evaluation works with validated data.
5. Python scientific routines evaluate supported checks and prepare evidence for reports. Groq is the selected AI provider in the current integration work.

The implementation and deployment are still being integrated. The [integration branch README](https://github.com/aeaayushdeep36-ship-it/Siphon/blob/coordination/shared-baseline-2026-11-11/README.md) describes its current configuration and verification commands in more detail. The code on `main` can lag behind that branch.

## Repository structure

```text
apps/web/            React and Vite frontend
apps/api/            Cloudflare Worker API and workflow components
packages/contracts/  Shared TypeScript contracts and schemas
packages/science/    Python scientific, validation and reporting routines
infra/firebase/      Firestore rules and indexes
docs/                Product, architecture, security and testing documents
scripts/             Build and verification utilities
```

## Getting started

The repository requires Node.js 24.x and npm. Python 3.11 is used for scientific verification. From the repository root:

```powershell
npm ci
npm run dev --workspace @siphon/web
```

The second command starts the frontend development server. Connecting it to the API and Firebase requires the appropriate local configuration. Copy the relevant example files under `apps/web` and `apps/api` and follow the documentation for the branch you are running. Browser `VITE_*` settings are public configuration; API keys and service-account credentials belong only in ignored server-side configuration or managed secrets.

For Python checks, create a Python 3.11 virtual environment and install `packages/science/requirements-dev.txt`. Common repository checks include:

```sh
npm test
npm run lint
npm run verify:science
npm run build
```

Live provider calls and sandbox runs have separate service and cost prerequisites. See the integration branch documentation before enabling a workflow or using external services.

## Documentation

- [Product requirements](docs/PRODUCT_REQUIREMENTS.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Security](docs/SECURITY.md)
- [Database](docs/DATABASE.md)
- [Design system](docs/DESIGN_SYSTEM.md)
- [Testing](docs/TESTING.md)
- [Code style](docs/CODE_STYLE.md)

## License

Siphon is distributed under the [MIT License](LICENSE).
