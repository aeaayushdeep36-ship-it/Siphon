import { type DocumentStore } from './firestore.js';
import { NumericExecutions } from './numeric-executions.js';

/** Scoped measurements, not scientific eligibility or a pass/fail finding. */
export class DiagnosticExecutions extends NumericExecutions {
  constructor(store: DocumentStore, clock: () => Date = () => new Date()) {
    super(store, 'diagnostics', clock);
  }
}
