/**
 * The run log's public surface: Studio → Runs & log (every automation run,
 * yours or the organisation's) and the words it phrases a run in. Import from
 * '@/features/runs', never from its internals.
 */

export { RunsLogScreen } from './screens/RunsLogScreen';
export { errorClassLabel, triggerLabel, whatHappened, type Happened, type Words } from './model/runLanguage';
