import { type DocumentStore } from './firestore.js';
import { NumericExecutions } from './numeric-executions.js';

/** Released sampled-state criteria, using the shared durable numeric lifecycle. */
export class ConservationExecutions extends NumericExecutions {
  constructor(store: DocumentStore, clock: () => Date = () => new Date()) {
    super(store, 'conservation', clock);
  }
}
