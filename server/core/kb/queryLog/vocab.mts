/**
 * vocab.mts: the closed vocabulary of the knowledge-base query log.
 *
 * One list per column that holds a fixed set of values, plus the caps on the
 * stored text. Shared by the recorder, the store, the routes and the builder
 * steps so none of them keeps its own copy.
 */

export const CHANNELS = [
    'agent_chat', 'agent_chat_sync', 'direct_chat', 'template_chat', 'notebook', 'webpage',
    'project_assistant', 'automation_ai_step', 'studio_kb_query', 'studio_ai_generate',
    'studio_ai_extract', 'studio_ai_chat', 'support', 'skill', 'kb_test', 'api_search',
] as const;
export type Channel = typeof CHANNELS[number];

/** Channels that only retrieve: there is no answer to wait for, the outcome follows from the chunks. */
export const RETRIEVAL_ONLY_CHANNELS: readonly Channel[] = ['studio_kb_query', 'api_search'];

export const OUTCOMES = ['answered', 'no_results', 'error'] as const;
export type Outcome = typeof OUTCOMES[number];

export const REVIEW_STATUSES = ['to_review', 'reviewed', 'needs_addition'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];

/** The retention choices of a knowledge base, in days. */
export const RETENTION_DAYS = [30, 90, 180, 365] as const;
export const DEFAULT_RETENTION_DAYS = 90;

/** Verbatim snapshot of a passage is cut at this many characters (the document can change later). */
export const CHUNK_TEXT_CAP = 2000;
export const QUERY_CAP = 8000;
export const ANSWER_CAP = 32000;

export const isChannel = (v: unknown): v is Channel => typeof v === 'string' && (CHANNELS as readonly string[]).includes(v);
export const isOutcome = (v: unknown): v is Outcome => typeof v === 'string' && (OUTCOMES as readonly string[]).includes(v);
export const isReviewStatus = (v: unknown): v is ReviewStatus => typeof v === 'string' && (REVIEW_STATUSES as readonly string[]).includes(v);
export const isRetentionDays = (v: unknown): v is typeof RETENTION_DAYS[number] => (RETENTION_DAYS as readonly number[]).includes(v as number);

/** Cut `value` to `cap` characters; non-strings become ''. */
export function cap(value: unknown, max: number): string {
    return typeof value === 'string' ? (value.length > max ? value.slice(0, max) : value) : '';
}
