/**
 * The public write-custody surface: one conservative writer per canonical
 * repository, admitted only against durable state.
 *
 * The custody runtime is split by reason to change, and this module is the
 * boundary the rest of the server imports:
 *   - custody/record-schema     what a durable record may legally look like
 *   - custody/durable-store     how that record reaches and leaves the disk
 *   - custody/reconciliation-policy  what a live coordinator may conclude about
 *                               a record another coordinator left behind
 *   - custody/custody-manager   the state machine that drives the three
 */

export {
  CUSTODY_KINDS,
  DURABLE_STATE_SCHEMA_VERSION,
  STATES,
  WriteCustodyError,
  custodyKindOf,
  repositoryIdForCanonicalRootKey,
  validateDurableOwnershipRecord
} from "./custody/record-schema.mjs";
export {
  defaultDurableStateRoot,
  executionHistoryDirectoryIn,
  repositoryStateDirectoryIn,
  worktreeDirectoryIn
} from "./custody/durable-store.mjs";
export { DurableWriteCustodyManager } from "./custody/custody-manager.mjs";

import { DurableWriteCustodyManager } from "./custody/custody-manager.mjs";

export const WriteCustodyManager = DurableWriteCustodyManager;
export const PROCESS_WRITE_CUSTODY = new DurableWriteCustodyManager();
