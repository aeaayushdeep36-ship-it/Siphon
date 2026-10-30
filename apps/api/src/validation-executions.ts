import { type DocumentStore } from './firestore.js';
import { NumericExecutions } from './numeric-executions.js';

/** Structural validation only; never enables a scientific check. */
export class ValidationExecutions extends NumericExecutions {
  constructor(store: DocumentStore, clock: () => Date = () => new Date()) {
    super(store, 'validation', clock);
  }
}
