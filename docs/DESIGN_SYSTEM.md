# Siphon design system and interaction specification

## Saved-state recovery (2026-11-11)

Connection failures during workspace/progress reads retain the last saved snapshots and display an explicit warning that they may be out of date. Read-only polling resumes automatically with bounded backoff; Refresh audit requests an immediate read. Navigation and sign-out stop the old poller, and terminal/historical server snapshots stop repeated polling. Reconnection never starts or repeats experiments. This change preserves the supplied console design; local polling tests do not establish a completed hosted journey.

## Frontend design integration (2026-11-09)

The React client now uses the supplied Siphon console design for the landing page, domain selection, audit workspace and evidence report. Heat and Gravitation select the corresponding existing domain values; workspace controls continue to use authenticated API contracts. Example audit data in the supplied design is not presented as a live result. Empty, blocked and unavailable states reflect the data and configuration actually returned by the application. The supplied imagery is stored in `apps/web/public/design/`, and smooth scrolling respects reduced-motion preferences.

Local browser checks used authored fixtures for audit creation, uploads, context and mapping answers, scientific questions, start/cancel/delete, revision creation, report rendering and PDF integrity handling. The checks do not establish hosted operation or a completed scientific audit. Firebase, E2B and other hosted services remain to be configured and verified; the backend still has the documented scientific planning and execution gaps. Older references below to a deferred homepage describe prior milestones.

## Current AI service presentation (2026-11-08)

Configured Groq inference, initially Qwen 3.8 27B, supersedes Meta-specific setup text below. Provider credentials are operator-only backend settings, never user upload fields or browser variables. Missing configuration, free-quota exhaustion/cooldown, unsupported request size and uncertain outcomes must remain operational blockers with truthful next actions. Do not show fake scientific failures, completed reviews, token counts or percentages, or silently truncate source to fit the independent byte screen.

AI interpretation/mapping remain backend-checked proposals; strict JSON is not scientific approval. Preserve option/custom-text questions, unknown assumptions, actual progress and evidence limitations. Hosted authenticated operation and the full audit/report flow remain unverified; homepage styling is still deferred. Conflicting older provider/status notes below remain historical.

Version: 1.1 | Updated: 2026-10-30 | Status: interaction contract with a locally reviewed report fixture; final visual identity/homepage is deferred.

## Deadline integration status (2026-10-30)

Integration update (2026-10-30): The native workflow now connects the source-bound adapter proposal to two separately gated baseline source attempts and data-only numeric validation. Local integration tests use authored provider fixtures; they do not establish hosted execution or adapter fidelity. Cross-run comparison, verified adapter publication, scientific planning and later end-to-end stages remain unfinished. Supporting CSV/NPY uploads currently require a numeric-input validator before baseline admission. Verified free-plan service configuration and the deferred Meta key are still needed for deployment.

Explicit POST revision resume now continues context review after a setup blocker without repeating inspection. It validates the current owner/input/generation and saved completed inspection before dispatching a stable request-key-derived Workflow instance. It never retries an unknown model operation; existing context count/model journals remain authoritative. The console offers this action only on a visible blocked running inspection/context stage. Authenticated hosted behavior remains unverified.

A functional React audit console now exists in apps/web; final marketing design remains deferred. It uses real API/authentication contracts with explicit configuration failure rather than a simulated login. Shared workspace/report views show actual operational blockers, ownership-sensitive history, source lifecycle/expiry, option groups with a persistent custom-text area, detailed plans/exclusions, real progress, exact evidence/plot data and matching PDF availability. Downloaded PDFs are length/hash checked before handoff. Signed-out requests are aborted and private UI state discarded. Browser verification currently covers only the configuration-missing sign-in screen; invited authenticated and end-to-end hosted experience remains unverified.

The private artifact backend is being migrated to a provider-hard-capped free alternative, not a promise that R2 free allowances guarantee a zero invoice. Missing model credentials are a project setup blocker and must remain visible instead of an endless unexplained spinner. A functional component or plotted authored fixture is not evidence that a real simulation completed an audit.

## Responsibility and principles

[Product requirements](PRODUCT_REQUIREMENTS.md) owns behavior/scope and limits; [Architecture](ARCHITECTURE.md) owns API/state vocabulary; [Database](DATABASE.md) owns retention; [Security](SECURITY.md) owns privacy/access; [Testing](TESTING.md) owns acceptance. This document owns user-facing presentation and accessibility, not numerical verdicts or a finalized brand palette.

Use Siphon consistently. Explain findings in plain language, with inspectable scientific detail. Lead with what was measured and what it means. State limitations near the result, not in hidden fine print. Never use animation or polished plots as evidence of correctness.

Build the backend contracts first. The initial functional React console is a review interface, not an approved final homepage. Use a small set of reusable components and semantic HTML; defer decorative illustration, marketing copy, logo, animation, and final colors/type choices until visual design is addressed. Use system fonts and neutral accessible defaults meanwhile.

## Functional surfaces

- Sign-in/invitation: Google sign-in, understandable denied-access state, retryable provider errors, no promise that signing in grants execution access. Never display tokens.
- Audit history: owner-only entries with domain, created/updated time, stage/status, revision, and report availability. Show expired evidence and deletion pending explicitly.
- Domain selection: Heat Diffusion and Orbital Dynamics choices with concise supported-scope text. No silent automatic classification; mismatch appears as an actionable readiness concern.
- Upload: existing source/supporting inputs, file listing, relevant Product limits, optional purpose/run context. No mandatory code template. Rejected files explain extension/size/path/dependency issues. Preserve selection when a recoverable error occurs.
- Inspection/context: short AI description, code-source references, declared/inferred/unknown distinctions, and readiness reasons. AI wording does not imply verified physics.
- Questions: the control contract below, preserving answers and revision awareness.
- Plan: selected checks, exclusions/unresolved assumptions, experiment controls, accuracy requirements, and estimated resource implications. Starting an audit accepts the revision's plan; no repeated approval for every check.
- Running audit: progress summary, timeline, actual completed/planned counts, bounded logs, cancellation, and surfaced findings.
- Evidence/report: summary, assumptions, adapter outcome, check cards, plots, metric details, causes as hypotheses, recommendations, limitations, reproduction references, and PDF download.

## Clarification question control

Each question contains a label, optional reason, keyboard-accessible option group, and a labelled custom-text area directly below the options. Offer an unknown choice when meaningful. Do not make the text area disappear merely because an option is selected. Preserve text when switching options or retrying.

Submission records selected option and/or custom text without silent precedence. Contradictions require reconciliation. Empty required responses produce inline errors and a focusable summary; unknown is a valid response whose consequences are explained, not an error that forces guessing. Clearly distinguish raw answer from AI interpretation. Subsequent questions target genuine ambiguity instead of repeating answered facts.

Submitting answers creates a successor revision as defined in Architecture. Show when earlier evidence belongs to older input. Prevent accidental double submission; the backend idempotency contract remains authoritative.

## Status language

Map canonical values without changing their meaning:

- `ready`: Ready for the next stage; not a scientific pass.
- `needs_input`: More information needed; show the affected stages/checks.
- `unsupported`: Outside current support; explain what is and is not established.
- `idle`: Draft or inactive work; no execution is implied.
- `queued`: Accepted and waiting for capacity; no experiment has started solely because it is queued.
- `running`: Active work in the named stage, with actual progress.
- `waiting_for_input`: Waiting for your answers; do not show an endless spinner.
- Plan eligibility labels: `eligible` means requirements satisfied, `unresolved` means required facts are missing, and `ineligible` means the confirmed model/capabilities do not support this check. Eligibility is distinct from a numerical evidence verdict.
- `completed`: Audit work completed; does not imply every check passed.
- `partial`: Some work/evidence is incomplete; retain usable results with reasons.
- `failed`: Work could not produce useful audit evidence; provide a safe explanation/retry path.
- `cancelled`: Cancellation recorded; show cleanup pending if provider termination is not verified.
- `passed_within_tolerance`: Within the stated tolerance for this check and scope.
- `flagged`: Evidence exceeds or violates this check's justified criterion; not automatically a diagnosed code bug.
- `inconclusive`: Insufficient assumptions, accuracy target, data, numerical resolution, or execution budget.
- `not_applicable`: This check does not apply to the confirmed model/capability.

Use text/icons as well as color. Do not call unknown, skipped, or unsupported checks passed. Never present a global green scientifically-correct badge or arbitrary reliability percentage.

## Progress and errors

Use the real current stage and concise activity from persisted events. If total experiment count is known, show completed/planned counts; do not turn them into an overall percentage that ignores other work. Use an indeterminate indicator only with meaningful accompanying text. Mark log coalescing/truncation and follow Product event limits.

Expose actionable distinctions: needs answer, unavailable capability, provider failure, quota/budget stop, unsupported source, and cancellation. Preserve completed evidence after failure. Reconnection shows last durable state and resumes listening without a new paid request. Do not expose stack traces, secrets, other users' data, or raw provider credentials.

Disable conflicting state-changing actions during submission and show why, but keep report/history navigation available. Cancellation immediately shows the request was recorded; do not claim the sandbox stopped until confirmed.

## Scientific evidence presentation

Each check card includes purpose, applicability, source/reference, observations used, metric value and unit, normalization scale, tolerance/accuracy policy, status, and limitations. Put actual evidence before possible explanations. Link hypotheses to evidence identifiers and source locations. Recommendations explain investigation and verification, without generated simulation code or patch/apply controls.

Plots need axis labels/units, legends when needed, baseline/refinement identities, and an accessible data/text summary. State downsampling; never use downsampled display data for the full numerical calculation. For heat show thickness/per-unit-thickness conventions; for orbits show frame, units, and horizon. Retain explicit missing/non-finite data states. Use scientific notation without rounding away a decisive difference; display precision must not imply unsupported accuracy.

## Accessibility and responsive behavior

Target WCAG 2.2 AA: keyboard operation, visible focus, semantic headings/landmarks, associated labels, sufficient contrast, accessible names, and reduced-motion support. Test desktop and 360 CSS-pixel viewport without page-wide horizontal overflow. Wide code/data panels can scroll within labelled regions.

Use a polite live region for coalesced progress; announce material transitions/errors rather than every log line. Focus errors after submission and preserve keyboard position during background updates. Charts must not be the only way to access a finding. Do not hide essential information behind hover-only interactions.

## Report/PDF agreement and privacy

The implemented report format distinguishes coverage at creation (full/limited) from overall run completion and export availability. Show incompleteReasons and read-time expired evidence/artifact IDs without silently changing old metric verdicts. Current retention metadata describes recorded expiry, not confirmed object availability. A missing/failed/unavailable/expired PDF is an explicit export state; the structured report remains readable. Report GET/download calls must not initiate new work.

The local export projection preserves exact round-trip metric values, support/intervals and units, distinguishes observed facts from possible causes, and labels plotted sampling separately. Its current fixed renderer uses hash-checked DejaVu fonts and paginated text/vector plots, with guards of sixty pages and 5 MiB output. Unsupported font glyphs or complex right-to-left shaping produce an explicit export failure; never substitute unreadable glyphs. These are current implementation limits, not final visual identity or permission to remove information from the on-screen report. An authored three-page PDF was inspected for alignment, pagination, scientific symbols, literal markup and full evidence/limitation visibility; a real report workflow remains unverified.

Screen and PDF consume the same versioned EvidenceReport. Generated charts and units/statuses must match. PDF includes the revision/report IDs, creation time, assumptions, limitations, citations, and artifact availability. Render in a trusted environment with a bundled verified Unicode font and safe mathematical images where necessary; test equations, pagination, links, long filenames, and scientific notation.

A PDF export error leaves the on-screen report readable with export unavailable, not a fake download. Warn before opening expired/missing evidence. Show raw-artifact/report retention from Database before upload and in history. Deletion confirms the actual audit title/revision scope and immediately removes access; irreversible user deletion may use a clear confirmation dialog. This does not imply confirmations for ordinary audit stages.

## Review criteria

Verify options plus custom text, unknown-answer paths, truthful statuses/progress, stale revisions, keyboard/screen-reader basics, responsive layout, privacy on sign-out, and matching screen/PDF outputs. Final visual design is a future decision; none of these controls require a finalized marketing homepage.
