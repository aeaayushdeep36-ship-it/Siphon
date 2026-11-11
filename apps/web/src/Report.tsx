import { EvidenceReportResponse } from '@siphon/contracts';
import type { z } from 'zod';
import { useState } from 'react';
import { digestBytes, RequestFailure, type AuditApi } from './api.js';
import { label } from './labels.js';

type ReportResponse = z.infer<typeof EvidenceReportResponse>;
function EvidencePlot({
  plot,
}: {
  plot: ReportResponse['report']['plots'][number];
}) {
  const points = plot.series.flatMap((series) => series.points);
  const xMagnitude = Math.max(...points.map((point) => Math.abs(point.x))) || 1;
  const yMagnitude = Math.max(...points.map((point) => Math.abs(point.y))) || 1;
  const xMin = Math.min(...points.map((point) => point.x / xMagnitude));
  const xMax = Math.max(...points.map((point) => point.x / xMagnitude));
  const yMin = Math.min(...points.map((point) => point.y / yMagnitude));
  const yMax = Math.max(...points.map((point) => point.y / yMagnitude));
  const x = (value: number) =>
    65 +
    (xMax === xMin ? 0.5 : (value / xMagnitude - xMin) / (xMax - xMin)) * 470;
  const y = (value: number) =>
    225 -
    (yMax === yMin ? 0.5 : (value / yMagnitude - yMin) / (yMax - yMin)) * 180;
  const colors = ['#f97316', '#7bd1fa', '#8ddbb5', '#e2b2d6'];
  return (
    <figure className="evidence-plot">
      <svg
        viewBox="0 0 600 300"
        role="img"
        aria-label={`${plot.title}. ${plot.description} Exact values are available in the accompanying data table.`}
      >
        <path d="M65 35V225H545" fill="none" stroke="#6b7b72" />
        <path d="M65 130H545M65 35H545" fill="none" stroke="#ffffff1a" />
        <text x="58" y="39" textAnchor="end" fontSize="10">
          {Math.max(...points.map((point) => point.y)).toString()}
        </text>
        <text x="58" y="225" textAnchor="end" fontSize="10">
          {Math.min(...points.map((point) => point.y)).toString()}
        </text>
        <text x="65" y="245" fontSize="11">
          {Math.min(...points.map((point) => point.x)).toString()}
        </text>
        <text x="535" y="245" textAnchor="end" fontSize="11">
          {Math.max(...points.map((point) => point.x)).toString()}
        </text>
        <text x="300" y="280" textAnchor="middle" fontSize="12">
          {plot.xLabel} ({plot.xUnit})
        </text>
        <text
          transform="translate(16 140) rotate(-90)"
          textAnchor="middle"
          fontSize="12"
        >
          {plot.yLabel} ({plot.yUnit})
        </text>
        {plot.series.map((series, index) => (
          <g key={series.label}>
            {plot.kind === 'line' && series.points.length > 1 ? (
              <polyline
                fill="none"
                stroke={colors[index]}
                strokeWidth="1.8"
                points={series.points
                  .map((point) => `${x(point.x)},${y(point.y)}`)
                  .join(' ')}
              />
            ) : (
              series.points.map((point, pointIndex) => (
                <circle
                  key={pointIndex}
                  cx={x(point.x)}
                  cy={y(point.y)}
                  r="2.2"
                  fill={colors[index]}
                />
              ))
            )}
          </g>
        ))}
      </svg>
      <figcaption>
        {plot.series.map((series, index) => (
          <span key={series.label} style={{ color: colors[index] }}>
            {series.label} · {series.points.length}/{series.originalPointCount}{' '}
            points;{' '}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
function TextList({ items }: { items: string[] }) {
  return (
    <ul>
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}
export function Report({
  value,
  api,
  onError,
}: {
  value: ReportResponse;
  api: AuditApi;
  onError: (error: unknown) => void;
}) {
  const report = value.report;
  const [downloading, setDownloading] = useState(false);
  async function download() {
    if (downloading || value.pdf.status !== 'available') return;
    const metadata = value.pdf;
    setDownloading(true);
    try {
      const response = await api.response(
        `/audits/${report.auditId}/revisions/${report.revisionId}/report.pdf`,
      );
      if (
        response.headers.get('Content-Type')?.split(';')[0] !==
        'application/pdf'
      )
        throw new RequestFailure(
          'invalid_pdf',
          'The service did not return a PDF. Refresh the report and retry.',
          null,
        );
      const bytes = await response.blob();
      if (
        bytes.size !== metadata.bytes ||
        (await digestBytes(await bytes.arrayBuffer())) !== metadata.sha256
      )
        throw new RequestFailure(
          'pdf_integrity',
          'The downloaded PDF does not match the published report metadata. Refresh the report and retry.',
        );
      const url = URL.createObjectURL(bytes);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `siphon-${report.reportId}.pdf`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      onError(error);
    } finally {
      setDownloading(false);
    }
  }
  return (
    <section
      aria-labelledby="report-title"
      className="panel report-panel"
      id="evidence"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            Evidence report · {label(report.coverage)} coverage
          </p>
          <h2 id="report-title">{report.title}</h2>
        </div>
        <button
          disabled={value.pdf.status !== 'available' || downloading}
          onClick={() => void download()}
        >
          {downloading ? 'Verifying PDF…' : 'Download PDF'}
        </button>
      </div>
      <p>{report.summary}</p>
      <p className="muted">
        PDF: {label(value.pdf.status)}. Report created{' '}
        {new Date(report.createdAt).toLocaleString()}; recorded expiry{' '}
        {new Date(report.expiresAt).toLocaleString()}.
      </p>
      {(value.retention.expiredEvidenceIds.length > 0 ||
        value.retention.expiredArtifactIds.length > 0) && (
        <p className="warning">
          Some evidence has expired. Reproduction is limited. Expired evidence:{' '}
          {value.retention.expiredEvidenceIds.join(', ') || 'none'}; artifacts:{' '}
          {value.retention.expiredArtifactIds.join(', ') || 'none'}.
        </p>
      )}
      <h3>Scope and limits</h3>
      <p>{report.scope}</p>
      <TextList items={[...report.incompleteReasons, ...report.limitations]} />
      <h3>
        Readiness:{' '}
        {report.readiness.status
          ? label(report.readiness.status)
          : 'not established'}
      </h3>
      <p>{report.readiness.explanation}</p>
      <h3>Adapter: {label(report.adapter.status)}</h3>
      <p>{report.adapter.explanation}</p>
      {report.adapter.comparedElements !== null && (
        <p>{report.adapter.comparedElements} elements compared.</p>
      )}
      <h3>Assumptions</h3>
      {report.assumptions.map((item) => (
        <p key={item.id}>
          <strong>{label(item.basis)}:</strong> {item.statement}
        </p>
      ))}
      <h3>Checks and numerical evidence</h3>
      {report.checks.map((check) => (
        <article className="check" key={check.checkId}>
          <h4>
            {check.checkId} · {label(check.selection)}
          </h4>
          <TextList items={check.reasons} />
          <p>{check.procedure}</p>
          <p>
            <strong>Accuracy policy:</strong> {check.accuracyPolicy}
          </p>
          <p>
            Required observations:{' '}
            {check.requiredObservations.join(', ') || 'none recorded'}
          </p>
          {report.metrics
            .filter((metric) => metric.checkId === check.checkId)
            .map((metric) => (
              <div key={metric.id} className="metric">
                <strong>{label(metric.status)}</strong>
                <p>
                  {label(metric.metric.name)}: {metric.metric.value.toString()}{' '}
                  {metric.metric.unit} · {metric.metric.normalization}{' '}
                  normalization
                </p>
                <p>
                  Target:{' '}
                  {metric.target
                    ? `${metric.target.value} ${metric.target.unit} — ${metric.target.justification}`
                    : 'not established'}
                </p>
                <p>
                  Uncertainty:{' '}
                  {metric.uncertainty
                    ? `${metric.uncertainty.value} ${metric.uncertainty.unit} — ${metric.uncertainty.justification}`
                    : 'not established'}
                </p>
                <p>
                  Interval:{' '}
                  {metric.interval
                    ? `[${metric.interval.lower}, ${metric.interval.upper}] ${metric.metric.unit}`
                    : 'unavailable'}{' '}
                  · {label(metric.reason)}
                </p>
                <TextList items={metric.limitations} />
                <small>
                  Evidence {metric.id}; experiments{' '}
                  {metric.experimentIds.join(', ')}
                </small>
              </div>
            ))}
        </article>
      ))}
      <h3>Experiments</h3>
      {report.experiments.map((experiment) => (
        <details key={experiment.id}>
          <summary>
            {experiment.description} · {label(experiment.status)}
          </summary>
          <TextList
            items={experiment.controls.map(
              (control) =>
                `${control.name}: ${String(control.value)} ${control.unit ?? ''}`,
            )}
          />
          <p>
            Operation: {experiment.sourceOperationId ?? 'none'}; result digest:{' '}
            {experiment.resultDigest ?? 'none'}
          </p>
        </details>
      ))}
      {report.plots.map((plot) => (
        <details key={plot.id}>
          <summary>{plot.title}</summary>
          <p>{plot.description}</p>
          <div className="plot-layout">
            <div>
              <EvidencePlot plot={plot} />
              <p>
                Axes: {plot.xLabel} ({plot.xUnit}); {plot.yLabel} ({plot.yUnit}
                ). Display points may be sampled; metrics use their recorded
                evidence.
              </p>
            </div>
            <div className="plot-data">
              {plot.series.map((series) => (
                <div key={series.label}>
                  <h4>{series.label}</h4>
                  <p>
                    {series.points.length} displayed of{' '}
                    {series.originalPointCount} original points. Experiment{' '}
                    {series.experimentId}.
                  </p>
                  <div
                    className="scroll-region"
                    data-lenis-prevent
                    tabIndex={0}
                    role="region"
                    aria-label={`${series.label} plot data`}
                  >
                    <table>
                      <thead>
                        <tr>
                          <th>
                            {plot.xLabel} ({plot.xUnit})
                          </th>
                          <th>
                            {plot.yLabel} ({plot.yUnit})
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {series.points.map((point, i) => (
                          <tr key={i}>
                            <td>{point.x.toString()}</td>
                            <td>{point.y.toString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </details>
      ))}
      <div className="narrative-grid">
        <div>
          <h3>Observed facts</h3>
          {report.narrative.facts.map((item, i) => (
            <p key={i}>
              {item.text} <small>Evidence: {item.evidenceIds.join(', ')}</small>
            </p>
          ))}
          {!report.narrative.facts.length && <p>None recorded.</p>}
        </div>
        <div>
          <h3>Possible causes · hypotheses</h3>
          {report.narrative.hypotheses.map((item, i) => (
            <div key={i}>
              <p>{item.text}</p>
              <p>Verify by: {item.verification}</p>
              <small>Evidence: {item.evidenceIds.join(', ')}</small>
            </div>
          ))}
          {!report.narrative.hypotheses.length && <p>None recorded.</p>}
        </div>
        <div>
          <h3>Recommendations</h3>
          {report.narrative.recommendations.map((item, i) => (
            <div key={i}>
              <p>{item.text}</p>
              <p>Validate by: {item.validation}</p>
              <small>Evidence: {item.evidenceIds.join(', ')}</small>
            </div>
          ))}
          {!report.narrative.recommendations.length && <p>None recorded.</p>}
        </div>
      </div>
      <h3>Reproduction</h3>
      <TextList
        items={[
          ...report.reproduction.instructions,
          ...report.reproduction.limitations,
        ]}
      />
      <h3>References</h3>
      <ul>
        {report.references.map((reference) => (
          <li key={reference.id}>
            <a href={reference.url} target="_blank" rel="noreferrer">
              {reference.title}
            </a>{' '}
            · accessed {reference.accessedAt}
          </li>
        ))}
      </ul>
      <details>
        <summary>Complete structured report and provenance</summary>
        <pre>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </section>
  );
}
