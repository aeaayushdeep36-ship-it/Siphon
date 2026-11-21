import { useEffect, useId, useState } from 'react';

/** Presentation model; the API contract is mapped to this by the workspace. */
export type AiDisclosureView = {
  configuration: {
    provider: string;
    model: string;
    endpoint: string;
    noticeVersion: string;
    scopes: readonly string[];
  };
  disclosureDigest: string;
  status: 'required' | 'accepted' | 'revoked';
  acceptedAt: string | null;
} | null;

const scopeLabels: Record<string, string> = {
  source_context:
    'Read source text to describe the existing simulation and its context.',
  source_adapter:
    'Read source text to propose mappings to reviewed observations.',
  numeric_investigation:
    'Read validated numerical evidence to draft possible explanations and investigations.',
};

export function AiDisclosurePanel({
  disclosure,
  disabled,
  onDecision,
}: {
  disclosure: AiDisclosureView;
  disabled: boolean;
  onDecision: (decision: 'accept' | 'revoke') => void;
}) {
  const checkboxId = useId();
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    setConfirmed(false);
  }, [disclosure?.disclosureDigest, disclosure?.status]);

  return (
    <section className="panel" aria-labelledby="ai-disclosure-heading">
      <p className="eyebrow">Data sharing · explicit permission</p>
      <h2 id="ai-disclosure-heading">Review AI data sharing</h2>
      {disclosure ? (
        <>
          <p>
            Siphon sends only the listed data scopes to the configured AI
            service for source context, mapping suggestions and advisory
            investigation. The service does not select scientific checks or
            determine numerical verdicts. Review the service and scope before
            allowing an audit to start.
          </p>
          <dl>
            <dt>Provider</dt>
            <dd>{disclosure.configuration.provider}</dd>
            <dt>Model</dt>
            <dd>{disclosure.configuration.model}</dd>
            <dt>Endpoint</dt>
            <dd>
              <code>{disclosure.configuration.endpoint}</code>
            </dd>
            <dt>Notice</dt>
            <dd>{disclosure.configuration.noticeVersion}</dd>
          </dl>
          <h3>Data sent for these purposes</h3>
          <ul>
            {disclosure.configuration.scopes.map((scope) => (
              <li key={scope}>
                <strong>{scopeLabels[scope] ?? scope}</strong>
              </li>
            ))}
          </ul>
          <p className="warning">
            Remove credentials and private information from uploads before
            sharing. Source scanning cannot guarantee that they are absent.
            Revoking permission prevents future authorized AI dispatches; it
            cannot recall data already sent.
          </p>
          {disclosure.status === 'accepted' ? (
            <>
              <p role="status">
                Permission recorded
                {disclosure.acceptedAt
                  ? ` on ${new Date(disclosure.acceptedAt).toLocaleString()}`
                  : ''}
                .
              </p>
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={disabled}
                  onClick={() => onDecision('revoke')}
                >
                  Revoke permission
                </button>
              </div>
            </>
          ) : (
            <>
              <fieldset disabled={disabled}>
                <legend>
                  {disclosure.status === 'revoked'
                    ? 'Permission was revoked for this audit revision.'
                    : 'Permission is required before AI assisted audit work can start.'}
                </legend>
                <label className="choice" htmlFor={checkboxId}>
                  <input
                    id={checkboxId}
                    type="checkbox"
                    checked={confirmed}
                    onChange={(event) =>
                      setConfirmed(event.currentTarget.checked)
                    }
                  />
                  <span>
                    I allow the listed source and evidence data to be sent to
                    this configured provider for the stated purposes.
                  </span>
                </label>
                <div className="actions">
                  <button
                    type="button"
                    disabled={disabled || !confirmed}
                    onClick={() => onDecision('accept')}
                  >
                    Allow AI data sharing
                  </button>
                </div>
              </fieldset>
            </>
          )}
        </>
      ) : (
        <p className="warning" role="status">
          No valid AI provider configuration is available. AI assisted audit
          work cannot start until the service is configured.
        </p>
      )}
    </section>
  );
}
