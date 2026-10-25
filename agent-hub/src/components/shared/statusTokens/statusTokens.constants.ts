import { type StatusKey, type SkipGroup } from './statusTokens.types';

/** The neutral recipe — four states share it; see `paused` for why. */
export const NEUTRAL_SOLID = 'text-[var(--text-tertiary)]';

export const NEUTRAL_SUBTLE = 'bg-[var(--bg-secondary)]';

export const NEUTRAL_BADGE = 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]';

/** Server-side spellings that mean a canonical key. */
export const ALIASES: Record<string, StatusKey> = {
    failed: 'error',
    awaiting_confirm: 'awaiting_approval',
    paused_breakpoint: 'paused',
};

export const SKIP_REASONS: Readonly<Record<string, SkipGroup>> = Object.freeze({
    // execution.js — the two "this step is not meant to run" cases.
    disabled: 'configured',
    note: 'configured',
    // execCollections.js / execFlow.js — a bound list that did not resolve,
    // or a field no item carries.
    arrayref_unresolved: 'no_work',
    overref_unresolved: 'no_work',
    aggregate_field_absent: 'no_work',
    summarize_field_absent: 'no_work',
    flatten_no_match: 'no_work', // a flatten whose inner list is on none of the outer items
    // execDateTime.js
    datetime_unresolved_input: 'no_work',
    // execDatatable.js
    datatable_column_unknown: 'no_work',
    datatable_filter_unresolved: 'no_work',
    datatable_values_unresolved: 'no_work',
    table_source_unresolved: 'no_work', // execTable.js
    // execKnowledgeWrite.js
    knowledge_write_empty: 'no_work',
    knowledge_write_no_kb: 'no_work',
    knowledge_write_too_long: 'no_work',
    knowledge_write_refused: 'no_work',
    // execOutbound.js — a notification whose only channel was email, and the
    // mail was not sent (runNotifications.js emailSkipOf).
    no_service_email: 'no_work',
    no_owner_email: 'no_work',
    not_sent: 'no_work',
    // execution.js — recorded as its own status by runDag, never as 'skipped'.
    pinned: 'pinned',
});
