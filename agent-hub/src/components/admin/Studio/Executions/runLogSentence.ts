/**
 * What a run did, in the run log's words: the SAME sentence the builder's
 * Runs tab shows (Builder/runs/runOutcome.ts, outcome codes through t()), with
 * one rule on top. A failure reads as its plain reason (the classifier's
 * errorInfo title, which the server copies into the outcome), never as the
 * raw server message. That message ("550 5.1.1 <...>: Recipient address
 * rejected") is handed back separately as `technical`, for a tooltip or a
 * "technical message" disclosure.
 *
 * Rows from before handoff 5 carry no outcome; those fall back to
 * runLanguage.whatHappened, except for failures, which get the reason from
 * the failed step's errorInfo or from the typed error class.
 */
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RunRowData } from '../../../../api/queries/automation/runs';
import { runSentence, runTone } from '../../../automation/Builder/runs/runOutcome';
import { whatHappened } from './runLanguage';

/** A row of the organisation-wide log: the Runs tab row plus the log's own fields. */
export interface RunLogRow extends RunRowData {
    automationTitle?: string | null;
    automationKind?: string | null;
    automationTriggerType?: string | null;
    journeyRunId?: string | null;
    handledErrorCount?: number | null;
    rootStepId?: string | null;
    rootTriggerLabel?: string | null;
    mine?: boolean;
}

/** The part of a step's `errorInfo` the log reads. */
export interface ErrorInfoLike {
    title?: string | null;
    titleKey?: string | null;
    params?: Record<string, unknown> | null;
    technical?: string | null;
}

export type LogTone = 'error' | 'warn' | 'neutral';

export interface RunLogSentence {
    text: string;
    tone: LogTone;
    /** The raw server message of a failure; null when there is none. */
    technical: string | null;
}

const FAILED = new Set(['error', 'failed']);

// The typed error classes, as the builder's generic stop reasons (same keys,
// so both screens translate them once).
const CLASS_REASON: Record<string, [string, string]> = {
    auth: ['session_expired', 'the sign-in has expired'],
    connection: ['unreachable', 'the service could not be reached'],
    network: ['unreachable', 'the service could not be reached'],
    timeout: ['timed_out', 'the service did not answer in time'],
    rate_limit: ['rate_limited', 'the service is limiting requests'],
    validation: ['missing_input', 'a required field is empty or invalid'],
    permission: ['no_access', 'no access'],
    cancelled: ['cancelled', 'it was cancelled'],
};

function text(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** A step's classified error as its plain title, in the reader's language. */
export function errorInfoTitle(t: TranslateFn, info: ErrorInfoLike | null | undefined): string | null {
    if (!info) return null;
    const title = text(info.title);
    if (info.titleKey) return text(t(info.titleKey, title, info.params || {})) || null;
    return title || null;
}

function classReason(t: TranslateFn, errorClass: string | null | undefined): string | null {
    const hit = CLASS_REASON[String(errorClass || '').toLowerCase()];
    return hit ? t(`runs.reason.${hit[0]}`, hit[1]) : null;
}

function toneOf(run: RunLogRow): LogTone {
    const tone = runTone(run);
    if (tone === 'error') return 'error';
    if (tone === 'waiting') return 'warn';
    return 'neutral';
}

/** A failure without an outcome: the step's errorInfo title, else the error class. */
function failureSentence(t: TranslateFn, run: RunLogRow, failedStep: ErrorInfoLike | null): string {
    const cause = errorInfoTitle(t, failedStep) || classReason(t, run.errorClass);
    return cause
        ? t('runs.sentence.failed_because', 'Stopped: {cause}', { cause })
        : t('runs.sentence.stopped', 'Stopped before it finished');
}

/** runLanguage's sentence for rows that carry no outcome. */
function legacySentence(t: TranslateFn, run: RunLogRow): RunLogSentence {
    const w = whatHappened(run);
    return { text: t(w.key, w.en, w.params), tone: w.tone === 'warn' ? 'warn' : 'neutral', technical: null };
}

/**
 * The run in one sentence. `failedStep` is the failed step's errorInfo when
 * the caller holds the step records (the open run does; the list does not).
 */
export function runLogSentence(t: TranslateFn, run: RunLogRow, failedStep: ErrorInfoLike | null = null): RunLogSentence {
    const failed = FAILED.has(String(run.status || '').toLowerCase());
    const technical = failed ? (text(run.error) || text(failedStep?.technical) || null) : null;

    // A rejection is a decision someone made, not a fault: runLanguage has
    // its own softer sentence for it, and the reason is a person's words.
    if (failed && run.errorClass === 'ApprovalRejected') return { ...legacySentence(t, run), tone: 'warn' };

    if (run.outcome?.code || text(run.outcome?.text)) {
        // Without the raw error: the builder's sentence reaches for it when
        // the outcome's reason is missing (the organisation log drops reasons
        // that are not generic), and then prints it verbatim.
        return { text: runSentence(t, { ...run, error: null }), tone: toneOf(run), technical };
    }
    if (failed) return { text: failureSentence(t, run, failedStep), tone: 'error', technical };
    return legacySentence(t, run);
}

/** The text a hover shows: the sentence, and the raw message when there is one. */
export function sentenceTooltip(t: TranslateFn, sentence: RunLogSentence): string {
    if (!sentence.technical) return sentence.text;
    return `${sentence.text}\n${t('runs.log.technical_tip', 'Technical message: {message}', { message: sentence.technical })}`;
}
