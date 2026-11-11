# Siphon product requirements

## Current AI decision (2026-11-08)

Groq's free API tier, initially configured as `qwen/qwen3.8-27b`, supersedes conflicting Meta selections, Standard-mode conditions and the USD 150 allocation below. Old Meta modules/fixtures remain legacy compatibility/history, not an automatic production fallback. Zero out-of-pocket spending and no paid upgrades remain requirements; a key alone does not verify the account's plan, limits or privacy settings.

For Groq, LIM-04 retains versioned revision attempt limits and bounded work, tightened by explicit `SIPHON_AI_*` settings. LIM-05's Meta credit allocation is inactive: reserve requests and full configured input-plus-output tokens under rolling 60-second and UTC-day quotas. Actual usage is reconciled; unknown completion retains reservations and forbids redispatch, while overruns halt later calls. Exhaustion is an operational limit, never a scientific failure or upgrade permission.

The initial no-tokenizer path screens complete serialized UTF-8 request bytes against the independently configured input-byte screen and transport-byte cap. The example sets a 6,000-byte screen separately from the 6,000-input/1,000-output token reservations; bytes are not measured rendered tokens or proof of context fit. Larger inputs may block without source truncation or invented tokenizer evidence. Structured AI output remains semantically checked, and deterministic code owns scientific verdicts. Live model quality, service access and the complete audit pipeline remain unverified.

Version: 1.2 | Updated: 2026-10-29 | Status: target specification; not a claim of complete implementation or scientific certification.

## Deadline integration status (2026-10-30)

Integration update (2026-10-30): The native workflow now connects the source-bound adapter proposal to two separately gated baseline source attempts and data-only numeric validation. Local integration tests use authored provider fixtures; they do not establish hosted execution or adapter fidelity. Cross-run comparison, verified adapter publication, scientific planning and later end-to-end stages remain unfinished. Supporting CSV/NPY uploads currently require a numeric-input validator before baseline admission. Verified free-plan service configuration and the deferred Meta key are still needed for deployment.

The current delivery objective includes the functional audit frontend and deployment by November 2, 2026, Asia/Kolkata. Complete FR-01 through FR-13 and AC-01 through AC-07; a first working conservation path is an intermediate milestone. The user explicitly permits any free artifact-storage alternative and will configure the Meta API key later. This supersedes the earlier requirement to obtain a separate storage-substitution decision. R2 stays disabled. The chosen implementation is private Cloudflare KV restricted to Workers Free, where provider operations stop at free quota; do not activate it under a paid account plan. Provisioning remains pending because the available OAuth permission could not read account subscriptions.

LIM-09 now applies to logical artifact-storage accounting regardless of provider; legacy r2_* internal counter names are retained temporarily for compatibility. KV additionally has stricter actual-operation limits: 512 MiB cumulative allocated bytes, 800 attempted physical writes per UTC day, and 80,000 attempted physical reads per UTC day. The application does not silently raise these ceilings or refund uncertain attempts. KV expiry is no later than the original artifact retention; metadata cleanup and confirmed-byte reclamation remain required. Source/PDF retention and all other LIM policies remain in force.

Implemented scientific release is restricted to dimensional invariant drift over reported samples for H_ENERGY, O_ENERGY, O_ANGULAR and O_MOMENTUM. Explicit target support and directed arithmetic enclosures are required for pass/flag results; physical accuracy, between-sample behavior, convergence and defect diagnosis are excluded from those claims. Missing targets/bounds are inconclusive. The other six required method families remain unfinished and disabled. This does not reduce the final agreed scientific scope.

## Purpose and document ownership

Siphon audits existing Python heat-diffusion and orbital simulations through applicable numerical experiments, reproducible evidence, and recommendations. It does not write replacement simulations or apply repairs. Initial users are invited researchers, scientific programmers, engineers, and students; market demand is not yet validated.

This document owns product scope, requirement IDs, limits, and acceptance criteria. [Architecture](ARCHITECTURE.md) owns interfaces/state; [Database](DATABASE.md) owns persistence; [Security](SECURITY.md) owns trust boundaries; [Testing](TESTING.md) owns verification; [Design system](DESIGN_SYSTEM.md) owns presentation; [Code style](CODE_STYLE.md) owns conventions; [AGENTS](../AGENTS.md) governs repository work. Conflicts are defects: resolve them and update affected documents together.

Repository: https://github.com/aeaayushdeep36-ship-it/Siphon. Intended checkout: `D:\Freelance\Siphon`. These documents do not establish a Git checkout, working remote access, or a deployed application.

## Supported scope

- SCOPE-01: Explicit `heat_diffusion` or `orbital_dynamics` selection, shared pipeline, separate reviewed registries. AI can flag a mismatch but cannot silently switch domains.
- SCOPE-02: Existing `.py` scripts and optional `.csv`/`.npy` numeric inputs. CSV uploads are headerless until the upload contract carries an explicit header declaration. Numeric files must be validated inside the isolated source sandbox before source execution; these checks establish numeric structure only, not units or scientific meaning. Admission stays blocked until server-side evidence identifies a pinned source build with the verified `headerless-csv-npy-v1` validator. No required user template. Approved simulation libraries: NumPy, SciPy, Matplotlib, Pint, REBOUND; pin tested versions at image construction. Exclude notebooks, archives, executables, pickle/object arrays, and unrestricted package installation.
- SCOPE-03: Transient linear 1D/2D Cartesian heat diffusion on rectangular uniform grids with constant positive conductivity/density/heat capacity. Declared temperature, normal-flux/insulated, or periodic boundaries and extractable sources; every combination needs explicit eligibility. Exclude curvilinear/unstructured meshes, variable properties, radiation/convection boundary models, phase changes, and coupled fluids.
- SCOPE-04: Deterministic 2D/3D Newtonian point-mass gravity: isolated mutually interacting bodies, or one test satellite in a fixed central field. Distinguish those profiles. Exclude drag, thrust, collisions, softening, relativity, prescribed moving massive bodies, changing masses, and long-term stability certification.
- SCOPE-05: Numerical observations and relevant controls must be extractable faithfully. Plot-only outputs without recoverable numerical evidence block dependent checks. Nondeterministic baselines are unsupported in v1. Missing capabilities exclude affected checks, not other eligible checks.
- SCOPE-06: Backend first; functional audit console follows verification. Final homepage styling and visual identity remain deferred.

## Functional requirements

- FR-01 Identity: Google sign-in through Firebase Authentication, active UID-based invitations, owner-only private audits. No public execution, sharing links, or collaboration roles.
- FR-02 Upload: Preserve bytes, safe relative paths, ownership, and SHA-256 hashes. Changes create successor revisions, not overwritten history.
- FR-03 Readiness: Cheap format/size/quota checks precede costly work. Isolated Python parsing must not import source. Return `ready`, `needs_input`, or `unsupported` with reasons. Reevaluate after consequential answers. Static inspection is not a safety certificate.
- FR-04 Context: AI supplies a brief description and structured facts with provenance and uncertainty. Never infer units from unlabelled arrays as fact.
- FR-05 Questions: Every question has options and a custom-text area below, with unknown where useful. Preserve raw answers, validate interpretations, follow up on ambiguity, and block only dependent work.
- FR-06 Adapter: AI proposes declarative mappings to reviewed handlers. Verify parameters, observations, shapes, units declarations, controls, and exactly matching deterministic original/adapted baseline arrays. Disagreement blocks dependent auditing. Preserve equations/defaults. Verification applies to the supported execution contract, not arbitrary semantic equivalence.
- FR-07 Plan: Deterministic predicates select reviewed/versioned checks with assumptions, required observations, procedure, sources, accuracy policy, interpretation, and cost. No AI-created checks or predicate bypass.
- FR-08 Execute: Run genuine bounded E2B experiments and record controls changed. Output sampling is distinct from internal timestep. Resource exhaustion is partial/inconclusive evidence, not scientific failure.
- FR-09 Evidence: Numerical code produces `passed_within_tolerance`, `flagged`, `inconclusive`, or `not_applicable`. Missing targets/unresolved uncertainty prevent unsupported passes. Preserve scales, units, thresholds, and limitations. No arbitrary global score/correctness certificate.
- FR-10 Investigation: AI links explanations to evidence IDs and separates facts from hypotheses. Recommend investigations and how to validate improvements; no patches, replacement source, or automatic fixes.
- FR-11 Progress: Real stages, experiment counts when known, bounded logs, warnings, errors; no fake percentage. Reconnection cannot repeat paid work.
- FR-12 Report: One structured report drives screen/PDF: scope, assumptions, unanswered questions, readiness, adapter verification, selected/excluded checks, settings, metrics, plots, recommendations, references, versions, reproduction data, limitations. Mark partial/expired evidence.
- FR-13 History: Private history and deletion. Deletion immediately revokes access and schedules full cleanup, including subcollections/artifacts/live jobs. Expired raw evidence limits reproduction claims.

## Canonical operating defaults

These versioned configurable resource policies are not scientific tolerances. Snapshot policy with each revision. Raising paid-service limits requires an explicit project-owner decision.

- LIM-01 Upload: 10 files, 5 MiB total; Python source at most 128 KiB combined. MiB means 1,048,576 bytes.
- LIM-02 Work: one active revision per user, three globally. Waiting for answers holds no slot; resumption reacquires one. Money reservations are separate.
- LIM-03 Admission: three cost-incurring revisions per user per UTC day, twenty globally. Charge once before first cost-incurring dispatch. Retries/resumes do not charge again; cheap rejected uploads do not consume admission.
- LIM-04 Model: eight total generation dispatch attempts per revision, including retries/questions/adapters; USD 2 per revision. At most 24,000 input tokens and a 4,000-token billable output allowance per attempt. Verify provider billing/counting semantics; reject work that cannot be bounded. Separate context-count preflight requests require verified no-charge availability and are capped at the stricter modelAttempts policy (eight per revision); these cannot grant generation or billing permission and cannot retry automatically.
- LIM-05 Meta: USD 150 confirmed allocation; initial application dispatch ceiling USD 135, reduced when verified account availability requires. Preserve at least USD 15 headroom against the verified allowance. App accounting cannot cap unrelated account usage.
- LIM-06 Execution: eight uploaded-code executions per revision, including original/adapted baselines/retries. Static parsing is not source execution. Inspection, source, trusted evaluation, and PDF sandboxes together get at most 900 billable sandbox-seconds per revision; parallel time is summed. Each sandbox lifetime is at most 180 seconds, further bounded by remaining allocation. No extension past cumulative cap.
- LIM-07 Artifacts: at most 50 MiB retained collected output per revision, including data/logs/charts/report files. Validate lengths and reserve cumulative storage before collection; label truncation. Original uploads use LIM-01 and count toward global storage.
- LIM-08 Dimensions: at most 65,536 heat-grid cells or 32 bodies per experiment, including refinements. Budget-ineligible work is not a scientific failure.
- LIM-09 R2: at most 2 GiB stored/reserved globally; monthly application ceilings 50,000 chargeable Class A and 250,000 Class B operations, including retries. Reconcile provider-wide use; stop before app caps. No guarantee about unrelated clients' charges.
- LIM-10 API: 60 authenticated requests per user per rolling minute, at most 10 mutations. Limit unauthenticated requests before costly processing. Ownership applies to endpoints/listeners.
- LIM-11 E2B: verify actual credits/expiry; set launch allocation to 90% of verified available credit and reconcile external consumption. Advertised USD 100 is one-time credit, not a verified balance or recurring free service. No automatic top-ups.
- LIM-12 Progress: coalesce to at most one update per five seconds plus meaningful stage/terminal transitions; at most 200 persisted events per revision. At cap, update bounded current/terminal summary rather than append logs.

## Release acceptance

- AC-01: Invited users complete both domains with independently authored supported scripts beyond demo fixtures.
- AC-02: Clean/faulty 2D heat and interacting multi-body cases produce expected evidence; 1D/two-body controls also pass their tests.
- AC-03: Unknown assumptions, bad adapters, absent observations, and unsupported physics never yield misleading passes or silent scope changes.
- AC-04: Check math, eligibility, tolerances, and references pass Testing's gates. No fixture-specific outcomes.
- AC-05: Ownership, isolation, quotas, concurrent reservations, duplicate dispatch prevention, cancellation, deletion, and provider failures are tested.
- AC-06: Real progress and screen/PDF evidence agree; partial reports retain provenance.
- AC-07: Hosted integration fits verified capabilities/free allowances. Record blockers instead of silent upgrades/provider substitution.

## Implementation evidence still needed

User-confirmed financial constraint (2026-10-29): no out-of-pocket spending or paid upgrades. Meta may use the stated USD 150 credits within LIM-05; other services require verified no-charge allowances/credits. R2 is usage-billed above its included Standard allowance and requires subscription checkout, so its cloud activation remains pending under this constraint. Application caps do not guarantee zero account-wide charges. Do not activate billing or substitute a storage provider without resolving this requirement with the user. Local development/tests may continue.

Credentials, balances, account configuration, sandbox controls, Worker CPU feasibility, scientific validation, and adapter coverage are release gates, not completed features. Authoring documents does not authorize credit spending, paid overages, deployment, or pushes. Research references/reading scope are in Testing within this eight-document set.
