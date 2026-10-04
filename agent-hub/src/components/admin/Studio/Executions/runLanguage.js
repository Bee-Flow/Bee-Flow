/**
 * runLanguage — every machine word the runs UI used to print, as a sentence.
 *
 * Pure and React-free: the table, the run bar and the timeline all read from
 * here, so "what happened" is phrased once. Where a sentence is shown by a
 * React caller it passes the `en` through t() with the paired key; pure
 * callers (tests, tooltips) read the English directly.
 */
import { tokenFor } from '../../../shared/statusTokens';

/**
 * One word for how the run ended — the table's Outcome column, as the same
 * `{ key, en }` pair `whatHappened` returns.
 *
 * It used to hand back a finished English string, because the status table
 * used to. That is how the runs list rendered a translated Dutch sentence
 * with an English status word inside it: the last branch of whatHappened
 * interpolated this into `automations.runs.status_plain` ("{status}"), and the
 * interpolated value never passed through t().
 */
export function outcomeLabel(run) {
    const token = tokenFor(run?.status);
    return { key: token.labelKey, en: token.labelEn };
}

/** The trigger kind as a person reads it — the "Started by" column. */
const TRIGGER_LABELS = {
    schedule: 'On a schedule',
    cron: 'On a schedule',
    manual: 'Started by hand',
    manual_step: 'Started by hand',
    dry_run: 'Test run',
    form: 'Someone filled in the form',
    form_page: 'Someone filled in the form',
    app_event: 'An app event',
    chat: 'Asked from chat',
    agent: 'Asked from chat',
    webhook: 'A webhook — another system called this',
};
export function triggerLabel(kind) {
    if (!kind) return '—';
    return TRIGGER_LABELS[String(kind).toLowerCase()] || String(kind).replace(/_/g, ' ');
}

/** The typed error class, in plain words (null for classes we cannot name). */
const ERROR_CLASS_LABELS = {
    auth: 'a connection is no longer signed in',
    connection: 'a connected app could not be reached',
    network: 'a connected app could not be reached',
    timeout: 'it took too long and was stopped',
    rate_limit: 'a connected app asked us to slow down',
    validation: 'a step received data it could not accept',
    permission: 'a permission was missing',
    cancelled: 'someone stopped it',
};
export function errorClassLabel(errorClass) {
    if (!errorClass) return null;
    return ERROR_CLASS_LABELS[String(errorClass).toLowerCase()] || null;
}

/** Trim server error text to one legible sentence for a table cell. */
function firstSentence(text, max = 140) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    const cut = s.length > max ? `${s.slice(0, max - 1)}…` : s;
    return cut;
}

/**
 * The table's "What happened" cell: { key, params, en, tone }.
 * Failures lead with the reason, not the word "error"; successes stay quiet.
 */
export function whatHappened(run) {
    const status = String(run?.status || '').toLowerCase();
    if (status === 'error' || status === 'failed') {
        // A rejection is a decision someone made on purpose, not a fault.
        // Reading "Failed — Approval rejected" next to real breakages teaches
        // people to ignore the error column, so it gets its own sentence and
        // the softer tone.
        if (run?.errorClass === 'ApprovalRejected') {
            const why = firstSentence(String(run?.error || '').replace(/^Approval rejected:?\s*/i, ''), 100);
            return why
                ? { key: 'automations.runs.rejected_because', params: { reason: why }, en: `Rejected — ${why}`, tone: 'warn' }
                : { key: 'automations.runs.rejected', params: {}, en: 'Rejected — someone turned this down', tone: 'warn' };
        }
        const classText = errorClassLabel(run?.errorClass);
        const detail = firstSentence(run?.error) || classText || 'Something went wrong';
        return { key: 'automations.runs.failed_because', params: { reason: detail }, en: `Failed — ${detail}`, tone: 'error' };
    }
    if (status === 'success') {
        const handled = Number(run?.handledErrorCount || 0);
        if (handled > 0) {
            // Distinct singular/plural keys — the dictionary value wins over
            // the en fallback, so pluralisation must live in the KEY choice.
            // The FALLBACK has to follow the key it belongs to. It used to
            // append the plural "s" from a ternary inside the template
            // literal, which put the English number rule back into JavaScript
            // one line under the key choice that had just taken it out. Two
            // complete sentences instead, picked together with their key.
            const { key, en } = handled === 1
                ? { key: 'automations.runs.finished_handled_one', en: `Finished — ${handled} problem handled automatically` }
                : { key: 'automations.runs.finished_handled', en: `Finished — ${handled} problems handled automatically` };
            return { key, params: { n: handled }, en, tone: 'warn' };
        }
        const summary = firstSentence(run?.summary, 100);
        if (summary) {
            return { key: 'automations.runs.finished_summary', params: { summary }, en: `Finished — ${summary}`, tone: 'neutral' };
        }
        return { key: 'automations.runs.finished', params: {}, en: 'Finished', tone: 'neutral' };
    }
    if (status === 'running' || status === 'queued') {
        return { key: 'automations.runs.still_running', params: {}, en: 'Still running…', tone: 'neutral' };
    }
    if (status === 'awaiting_approval' || status === 'awaiting_confirm') {
        return { key: 'automations.runs.waiting_approval', params: {}, en: 'Waiting for someone to approve it', tone: 'warn' };
    }
    if (status === 'awaiting_form') {
        return { key: 'automations.runs.waiting_form', params: {}, en: 'Waiting for a form to be filled in', tone: 'warn' };
    }
    if (status === 'cancelled') {
        return { key: 'automations.runs.stopped_by_user', params: {}, en: 'Stopped before it finished', tone: 'neutral' };
    }
    // Everything else: the status word IS the sentence. It carries its own
    // key rather than being interpolated into a "{status}" wrapper, so it is
    // translated by the same dictionary entry the Outcome column uses.
    const outcome = outcomeLabel(run);
    return { key: outcome.key, params: {}, en: outcome.en, tone: 'neutral' };
}

/**
 * A run's display name — "Run of 12 Aug 2026, 14:03 · test". Replaces the
 * truncated hex id nobody could read. The raw id stays available in ⋯.
 */
export function runTitle(run, locale = undefined) {
    if (!run?.startedAt) return run?.id ? `Run ${String(run.id).slice(0, 8)}` : 'Run';
    let stamp;
    try {
        stamp = new Date(run.startedAt).toLocaleString(locale, {
            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        });
    } catch {
        stamp = new Date(run.startedAt).toISOString().slice(0, 16).replace('T', ' ');
    }
    return `Run of ${stamp}${run.mode === 'dry_run' ? ' · test' : ''}`;
}

/**
 * Pull a run id out of pasted text — a full deep link (?run=<id>), a URL with
 * the id in the path, or a bare id. Null when nothing id-shaped is found.
 */
export function runIdFromText(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    const fromQuery = /[?&]run=([A-Za-z0-9_-]{6,})/.exec(s);
    if (fromQuery) return fromQuery[1];
    // A bare id: one url-safe token, no spaces, reasonably long.
    if (/^[A-Za-z0-9_-]{6,}$/.test(s) && !s.includes('/')) return s;
    // Last path-ish segment that looks like an id (run_… or a uuid-ish blob).
    const seg = s.split(/[/?#]/).filter(Boolean).pop() || '';
    if (/^(run_)?[A-Za-z0-9-]{6,}$/.test(seg) && /\d/.test(seg)) return seg;
    return null;
}

/**
 * Which ENTRY POINT a run came in through, for an automation with more than one
 * trigger: the label of the definition.triggers[] node it started from, or
 * null when it started from the primary trigger (or the automation has only
 * one). List rows carry the label resolved server-side against the current
 * definition; an open run resolves it against the versioned snapshot that
 * actually ran, so a trigger renamed since still reads as it was.
 */
export function enteredTriggerLabel(run, definition = null) {
    if (!run?.rootStepId) return null;
    const node = (Array.isArray(definition?.triggers) ? definition.triggers : []).find(t => t?.id === run.rootStepId);
    if (node) return String(node.label || node.appEvent?.event || node.kind || run.rootStepId);
    return run.rootTriggerLabel ? String(run.rootTriggerLabel) : null;
}
