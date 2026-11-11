import type { InvestigationReviewSnapshot } from '@siphon/contracts';
import { label } from './labels.js';

export function InvestigationReview({
  snapshot,
  disabled,
  onReview,
}: {
  snapshot: InvestigationReviewSnapshot;
  disabled: boolean;
  onReview: (decision: 'accept' | 'omit') => void;
}) {
  return (
    <section className="panel" aria-labelledby="investigation-heading">
      <p className="eyebrow">
        Advisory investigation · {label(snapshot.status)}
      </p>
      <h2 id="investigation-heading">
        Review explanations and recommendations
      </h2>
      <p>
        {snapshot.provider} · {snapshot.model}. These are possible explanations
        and suggested investigations, not established findings. Accepting text
        includes it as advisory material in the report; it cannot change the
        deterministic metrics or verdicts. Omitting it keeps the numerical
        evidence and records that advisory text was omitted.
      </p>
      <p className="muted">
        Recorded draft expiry: {new Date(snapshot.expiresAt).toLocaleString()}
      </p>
      <h3>Deterministic evidence behind this advisory</h3>
      <p>
        These validated metric records are the numerical evidence supplied to
        the advisory step. The values and verdicts come from deterministic
        checks; advisory text cannot change them.
      </p>
      {snapshot.evidence.map((item) => (
        <article className="metric" key={item.id}>
          <strong>
            {label(item.status)} · {item.checkId} {item.checkVersion}
          </strong>
          <p>
            {label(item.metric.name)}: {item.metric.value.toString()}{' '}
            {item.metric.unit} · {item.metric.normalization} normalization
          </p>
          <p>
            Target:{' '}
            {item.target
              ? `${item.target.value} ${item.target.unit} — ${item.target.justification}`
              : 'not established'}
          </p>
          <p>
            Uncertainty:{' '}
            {item.uncertainty
              ? `${item.uncertainty.value} ${item.uncertainty.unit} — ${item.uncertainty.justification}`
              : 'not established'}
          </p>
          <p>
            Interval:{' '}
            {item.interval
              ? `[${item.interval.lower}, ${item.interval.upper}] ${item.metric.unit}`
              : 'unavailable'}{' '}
            · {label(item.reason)}
          </p>
          <ul>
            {item.limitations.map((limitation, index) => (
              <li key={index}>{limitation}</li>
            ))}
          </ul>
          <small>Metric evidence: {item.id}</small>
        </article>
      ))}
      <h3>Possible explanations</h3>
      {snapshot.draft.hypotheses.length ? (
        snapshot.draft.hypotheses.map((item, index) => (
          <article key={index}>
            <p>{item.text}</p>
            <p>
              <strong>Verify by:</strong> {item.verification}
            </p>
            <small>Evidence: {item.evidenceIds.join(', ')}</small>
          </article>
        ))
      ) : (
        <p>No explanations proposed.</p>
      )}
      <h3>Suggested investigations</h3>
      {snapshot.draft.recommendations.length ? (
        snapshot.draft.recommendations.map((item, index) => (
          <article key={index}>
            <p>{item.text}</p>
            <p>
              <strong>Validate by:</strong> {item.validation}
            </p>
            <small>Evidence: {item.evidenceIds.join(', ')}</small>
          </article>
        ))
      ) : (
        <p>No recommendations proposed.</p>
      )}
      {snapshot.status === 'awaiting_review' ? (
        <>
          <p>
            Review is saved for this exact draft and cannot be changed. Saving
            it does not start another model call or prepare the report
            automatically. Then choose Resume report preparation in the test
            plan.
          </p>
          <div className="actions">
            <button disabled={disabled} onClick={() => onReview('accept')}>
              Include advisory text
            </button>
            <button
              className="secondary"
              disabled={disabled}
              onClick={() => onReview('omit')}
            >
              Omit advisory text
            </button>
          </div>
        </>
      ) : snapshot.status === 'expired' ? (
        <p className="warning">
          This draft has expired and cannot be reviewed. Report preparation is
          blocked; refreshing reads saved state and does not regenerate the
          draft.
        </p>
      ) : (
        <p role="status">
          {snapshot.status === 'accepted'
            ? 'Advisory text accepted.'
            : 'Advisory text omitted.'}{' '}
          Numerical verdicts are unchanged. For the current unfinished revision,
          use Resume report preparation in the test plan when ready.
        </p>
      )}
    </section>
  );
}
