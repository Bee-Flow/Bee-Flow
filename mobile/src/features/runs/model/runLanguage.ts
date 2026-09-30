/**
 * Every machine word the run log would otherwise print, as a sentence — a port
 * of agent-hub/src/components/admin/Studio/Executions/runLanguage.js, pinned
 * to it by runLanguage.lockstep.test.ts (a differential test: the web module
 * runs beside this one on the same runs).
 *
 * The English is the web's, word for word. What differs is the KEY: the web
 * phrases `whatHappened` under `routines.runs.*`, keys that exist in neither
 * English dictionary, so the phone could never have them translated. Every
 * sentence here carries a `mobile.runs.*` key instead, and HAPPENED_KEYS says
 * which web key each one stands for, so the lockstep test can hold the two
 * vocabularies together.
 */

import { errorClassWords, statusToken, triggerWords, type Words } from '@/features/automations';

// The trigger and error-class tables live in features/automations (its
// model/runWords.ts), which this feature already depends on: the automations
// run screens say the same words, and a table here would make them import
// back into runs — a feature cycle. Re-exported, so this port still offers
// everything the web module does.
export { errorClassWords, triggerWords, type Words };

export type HappenedTone = 'neutral' | 'warn' | 'error';

export interface Happened extends Words {
    params: Record<string, string | number>;
    tone: HappenedTone;
}

/** The web's `whatHappened` key → the phone's own key for the same sentence. */
export const HAPPENED_KEYS: Readonly<Record<string, string>> = Object.freeze({
    'routines.runs.rejected_because': 'mobile.runs.happened.rejected_because',
    'routines.runs.rejected': 'mobile.runs.happened.rejected',
    'routines.runs.failed_because': 'mobile.runs.happened.failed_because',
    'routines.runs.finished_handled_one': 'mobile.runs.happened.finished_handled_one',
    'routines.runs.finished_handled': 'mobile.runs.happened.finished_handled',
    'routines.runs.finished_summary': 'mobile.runs.happened.finished_summary',
    'routines.runs.finished': 'mobile.runs.happened.finished',
    'routines.runs.still_running': 'mobile.runs.happened.still_running',
    'routines.runs.waiting_approval': 'mobile.runs.happened.waiting_approval',
    'routines.runs.waiting_form': 'mobile.runs.happened.waiting_form',
    'routines.runs.stopped_by_user': 'mobile.runs.happened.stopped_by_user',
});

const happened = (webKey: string, en: string, tone: HappenedTone, params: Happened['params'] = {}): Happened => ({
    key: HAPPENED_KEYS[webKey] ?? webKey,
    en,
    params,
    tone,
});

/** One word for how the run ended — the run_status.* vocabulary the automations screens use. */
export function outcomeLabel(run: { status?: string | null } | null | undefined): Words {
    const token = statusToken(run?.status ?? null);
    return { key: token.labelKey, en: token.labelEn };
}

/** The web's English for a trigger kind — the known phrase, else the kind with spaces. */
export function triggerLabel(kind: string | null | undefined): string {
    if (!kind) return '—';
    return triggerWords(kind)?.en ?? String(kind).replace(/_/g, ' ');
}

export function errorClassLabel(errorClass: string | null | undefined): string | null {
    return errorClassWords(errorClass)?.en ?? null;
}

/** Server error text as one legible cell: whitespace folded, cut at `max`. */
function firstSentence(text: unknown, max = 140): string {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** As much of a run as the sentence reads. */
export interface RunLike {
    status?: string | null;
    error?: string | null;
    errorClass?: string | null;
    summary?: string | null;
    handledErrorCount?: number | null;
}

function failed(run: RunLike): Happened {
    // A rejection is a decision somebody made, not a fault: its own sentence
    // and the softer tone, so the error column stays worth reading.
    if (run.errorClass === 'ApprovalRejected') {
        const why = firstSentence(String(run.error ?? '').replace(/^Approval rejected:?\s*/i, ''), 100);
        return why
            ? happened('routines.runs.rejected_because', `Rejected — ${why}`, 'warn', { reason: why })
            : happened('routines.runs.rejected', 'Rejected — someone turned this down', 'warn');
    }
    const detail = firstSentence(run.error) || errorClassLabel(run.errorClass) || 'Something went wrong';
    return happened('routines.runs.failed_because', `Failed — ${detail}`, 'error', { reason: detail });
}

function succeeded(run: RunLike): Happened {
    const handled = Number(run.handledErrorCount || 0);
    if (handled > 0) {
        return handled === 1
            ? happened('routines.runs.finished_handled_one', `Finished — ${handled} problem handled automatically`, 'warn', { n: handled })
            : happened('routines.runs.finished_handled', `Finished — ${handled} problems handled automatically`, 'warn', { n: handled });
    }
    const summary = firstSentence(run.summary, 100);
    if (summary) return happened('routines.runs.finished_summary', `Finished — ${summary}`, 'neutral', { summary });
    return happened('routines.runs.finished', 'Finished', 'neutral');
}

/** The "What happened" line. Failures lead with the reason; successes stay quiet. */
export function whatHappened(run: RunLike | null | undefined): Happened {
    const r = run ?? {};
    const status = String(r.status ?? '').toLowerCase();
    if (status === 'error' || status === 'failed') return failed(r);
    if (status === 'success') return succeeded(r);
    if (status === 'running' || status === 'queued') return happened('routines.runs.still_running', 'Still running…', 'neutral');
    if (status === 'awaiting_approval' || status === 'awaiting_confirm') {
        return happened('routines.runs.waiting_approval', 'Waiting for someone to approve it', 'warn');
    }
    if (status === 'awaiting_form') return happened('routines.runs.waiting_form', 'Waiting for a form to be filled in', 'warn');
    if (status === 'cancelled') return happened('routines.runs.stopped_by_user', 'Stopped before it finished', 'neutral');
    // Everything else: the status word is the sentence, under its own key.
    const outcome = outcomeLabel(r);
    return { key: outcome.key, en: outcome.en, params: {}, tone: 'neutral' };
}

/**
 * The entry point a run came in through, for a routine with several triggers:
 * the label the server resolved for the list row, else null.
 */
export function enteredTriggerLabel(run: { rootStepId?: string | null; rootTriggerLabel?: string | null }): string | null {
    if (!run.rootStepId) return null;
    return run.rootTriggerLabel ? String(run.rootTriggerLabel) : null;
}
