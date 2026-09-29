/**
 * What the shield did with a message or a tool call, in a few words an admin
 * reads at a glance — and the one place that decides which stored value means
 * which.
 *
 * Two ledgers feed the "What happened" pane and the 30-day figures elsewhere
 * on the Privacy Shield:
 *
 *   guardrail_events         one row per time the shield ACTED on a message:
 *                            action_taken = tokenized, redacted, blocked, …
 *   integration_activity_log one row per call to an outside service, with the
 *                            kinds of personal data found in it (if any)
 *
 * The design groups both into outcomes. The mapping is a WHITELIST on purpose:
 * `guardrail_events` also carries nc_scope configuration-audit rows
 * (violation_type admin_action / user_action) whose `action_taken` is free
 * text, and those are neither a message nor a call. They are excluded, never
 * guessed into a bucket.
 *
 * An action alone is not enough to decide. The same stored word means
 * different things under different violation types: 'scan_failed' is a
 * routine that refused to send content it could not check (type
 * 'scan_failed'), but a chat message that went out unchecked (type
 * 'dlp_decision'); 'stripped' is hidden Unicode characters removed from a
 * prompt, not personal data. So every row is read as (action, violation type).
 *
 * Counting rule, so the unfiltered aggregate and a filtered sample agree:
 * replaced / stopped / passed come from shield events, tool / clean /
 * unchecked from calls. A blocked tool call writes BOTH a shield row and a
 * call row, so a sample that counts rows may show it twice — the log shows
 * both records, and the sample figures count log rows. The aggregate counts
 * the stop once, from the shield event, and the blocked call in no bucket.
 */

export type Outcome = 'replaced' | 'stopped' | 'tool' | 'passed' | 'clean' | 'unchecked' | 'other';

/** The order outcomes are listed in: the shield's own work first, then what got past it. */
export const OUTCOME_ORDER: Outcome[] = ['replaced', 'stopped', 'tool', 'passed', 'clean', 'unchecked', 'other'];

/** Shield-event actions where the personal data was swapped for placeholders or removed. */
export const REPLACED_ACTIONS = new Set(['tokenized', 'redacted', 'tool_result_redacted', 'partial_redacted']);

/** Shield-event actions where the message, search or tool call did not go out. */
export const STOPPED_ACTIONS = new Set(['blocked', 'search_blocked', 'tool_blocked', 'held']);

/**
 * Shield-event actions where something went out that the shield did not
 * change: a person chose "Send anyway", the shield only noted what it found,
 * or the check could not run and the policy said to send it unchecked. Rare,
 * but never hidden inside another bucket — and not all of it is personal data
 * FOUND, so the pane words this bucket as "let through", never as a find.
 */
export const PASSED_ACTIONS = new Set(['allowed', 'pii_detected', 'passed_unredacted', 'scan_failed']);

/** Configuration-audit rows that share the table but are not about a message. */
export const AUDIT_VIOLATION_TYPES = new Set(['admin_action', 'user_action']);

/**
 * Shield events that are about a message but not about personal data in it:
 * hidden Unicode characters removed from a prompt (`unicode_smuggling`, whose
 * categories column reads "12 hidden chars") and operator notes about the
 * placeholder store (`pii_tokenmap`). Shown in the log as "Other"; their
 * categories column holds a note, never kinds of personal data.
 */
export const NOTE_VIOLATION_TYPES = new Set(['unicode_smuggling', 'pii_tokenmap']);

/**
 * The check could not run. The categories column of these rows holds a
 * marker ("protection was unavailable"), never a kind that was found.
 */
export const CHECK_FAILED_TYPES = new Set(['scan_failed', 'pii_unavailable']);

/** Is this shield-event row an audit record rather than something that happened to a message? */
export function isAuditRow(row: { violation_type?: string | null } | null | undefined): boolean {
    return AUDIT_VIOLATION_TYPES.has(String(row?.violation_type || ''));
}

/** Can this shield event's categories column name kinds of personal data found? */
export function carriesKinds(violationType: string | null | undefined): boolean {
    const type = String(violationType || '');
    return !AUDIT_VIOLATION_TYPES.has(type) && !NOTE_VIOLATION_TYPES.has(type) && !CHECK_FAILED_TYPES.has(type);
}

/** A shield event's (`action_taken`, `violation_type`) → its outcome. Unknown values are 'other', never a guess. */
export function outcomeOfAction(action: string | null | undefined, violationType: string | null | undefined): Outcome {
    const a = String(action || '');
    const type = String(violationType || '');
    if (NOTE_VIOLATION_TYPES.has(type)) return 'other';
    // A routine told to fail closed writes 'scan_failed' under its own type
    // and throws: the content never left.
    if (a === 'scan_failed' && type === 'scan_failed') return 'stopped';
    if (REPLACED_ACTIONS.has(a)) return 'replaced';
    if (STOPPED_ACTIONS.has(a)) return 'stopped';
    if (PASSED_ACTIONS.has(a)) return 'passed';
    return 'other';
}

/**
 * A tool call's outcome. A blocked call did not go out; one with kinds of
 * personal data left with them; one that was never scanned is 'unchecked'
 * (checking connected-app content is off by default, so this is the common
 * case, and "No personal data" would read as an all-clear it is not); a
 * scanned call with nothing found is 'clean'.
 *
 * `scanLevel` is the row's `pii_scan_level`. A row without one (an older
 * server) keeps the old reading rather than turning every call grey.
 */
export function outcomeOfCall(status: string | null | undefined, kindCount: number, scanLevel?: string | null): Outcome {
    if (String(status || '') === 'blocked') return 'stopped';
    if (kindCount > 0) return 'tool';
    return scanLevel === 'none' ? 'unchecked' : 'clean';
}

export interface ByActionRow {
    action_taken?: string | null;
    violation_type?: string | null;
    count?: number | string | null;
}

/** Sum the guard overview's `by_action` rows per outcome, audit rows excluded. */
export function sumByAction(rows: ByActionRow[] | null | undefined): Record<'replaced' | 'stopped' | 'passed', number> {
    const out = { replaced: 0, stopped: 0, passed: 0 };
    for (const row of rows || []) {
        if (isAuditRow(row)) continue;
        const outcome = outcomeOfAction(row.action_taken, row.violation_type);
        if (outcome === 'replaced' || outcome === 'stopped' || outcome === 'passed') {
            out[outcome] += Number(row.count) || 0;
        }
    }
    return out;
}
