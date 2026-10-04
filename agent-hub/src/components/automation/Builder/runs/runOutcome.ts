/**
 * The Runs tab's words: one sentence per run from its outcome code, the meta
 * line under it, the day groups. Pure; every caller passes its own t().
 *
 * Rows from before handoff 5 carry no outcome, so each helper falls back to
 * what those rows do carry (status, summary, error, triggerKind).
 */
import type { TranslateFn } from '../../../../hooks/useTranslation';
import type { RunRowData } from '../../../../api/queries/automation/runs';

export type RunTone = 'success' | 'error' | 'waiting' | 'running' | 'neutral';

const WAITING = new Set(['awaiting_approval', 'awaiting_confirm', 'awaiting_form']);

/** Which of the five looks a run gets: icon, colour, row actions. */
export function runTone(run: RunRowData): RunTone {
    const s = String(run.status || '').toLowerCase();
    if (s === 'error' || s === 'failed') return 'error';
    if (WAITING.has(s)) return 'waiting';
    if (s === 'running' || s === 'queued') return 'running';
    if (s === 'success') return 'success';
    return 'neutral';
}

function param(run: RunRowData, name: string): string {
    const v = run.outcome?.params?.[name];
    return v == null ? '' : String(v);
}

function oneLine(text: unknown, max = 140): string {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

type Sentence = (t: TranslateFn, run: RunRowData) => string;

// The generic stop reasons the server words (server/automation/runOutcome.js
// REASONS). A reason that reads differently came from the failing step's
// own error title and is shown as the server sent it.
const REASONS: Record<string, string> = {
    no_access: 'no access',
    not_connected: 'the account is not connected',
    session_expired: 'the sign-in has expired',
    app_disabled: 'the app is not enabled for this account',
    not_found: 'the file, board or room was not found',
    target_conflict: 'the target location is missing or already exists',
    missing_input: 'a required field is empty or invalid',
    timed_out: 'the service did not answer in time',
    unreachable: 'the service could not be reached',
    temporarily_unavailable: 'the service was temporarily unavailable',
    rate_limited: 'the service is limiting requests',
    app_refused: 'the connected app refused the request',
    approval_expired: 'nobody decided the approval in time',
    run_timeout: 'the run took longer than its time limit',
    blocked_by_privacy: 'the Privacy Shield blocked it',
    cancelled: 'it was cancelled',
    unexpected: 'something unexpected went wrong',
};

/** The server's English for a generic reason, including the two that name a place. */
function genericReason(code: string, where: string): string | null {
    if (where && code === 'no_access') return `no access to ${where}`;
    if (where && code === 'not_found') return `${where} was not found`;
    return REASONS[code] ?? null;
}

/** Why a run stopped, translated when it is one of the generic reasons. */
function stopReason(t: TranslateFn, run: RunRowData): string {
    const code = param(run, 'reasonCode');
    const reason = param(run, 'reason');
    const where = param(run, 'where');
    const english = code ? genericReason(code, where) : null;
    // Anything else is the failing step's own error title: shown as sent.
    if (!english || (reason && reason !== english)) return oneLine(reason) || oneLine(run.error);
    if (where && code === 'no_access') return t('runs.reason.no_access_to', 'no access to {where}', { where });
    if (where && code === 'not_found') return t('runs.reason.not_found_at', '{where} was not found', { where });
    return t(`runs.reason.${code}`, english);
}

// The list nouns the server names in English (plural); others read as sent.
const NOUNS: Record<string, [string, string]> = {
    files: ['file', 'files'],
    emails: ['email', 'emails'],
    items: ['item', 'items'],
};

function nounFor(t: TranslateFn, noun: string, count: number): string {
    const pair = NOUNS[noun];
    if (!pair) return noun;
    return count === 1 ? t(`runs.noun.${pair[0]}`, pair[0]) : t(`runs.noun.${pair[1]}`, pair[1]);
}

/** "23 files found in the main folder". */
function listSentence(t: TranslateFn, run: RunRowData): string {
    const count = Number(run.outcome?.params?.count) || 0;
    const noun = nounFor(t, param(run, 'noun') || 'items', count);
    const whereRaw = param(run, 'where');
    const where = whereRaw === '/' ? t('runs.sentence.main_folder', 'the main folder') : whereRaw;
    return where
        ? t('runs.sentence.found_in', '{count} {noun} found in {where}', { count, noun, where })
        : t('runs.sentence.found', '{count} {noun} found', { count, noun });
}

/** A file name or up to two record values, as one short result. */
function resultOf(run: RunRowData): string {
    const kind = param(run, 'kind');
    if (kind === 'file') return oneLine(param(run, 'name'));
    const fields = run.outcome?.params?.fields;
    if (kind === 'record' && Array.isArray(fields)) return oneLine(fields.map(String).join(' · '));
    return '';
}

/** What a successful run produced. */
function successCore(t: TranslateFn, run: RunRowData): string {
    if (param(run, 'kind') === 'list') return listSentence(t, run);
    const step = param(run, 'step');
    const result = resultOf(run);
    if (result) return step ? t('runs.sentence.step_result', '{step}: {result}', { step, result }) : result;
    if (step) return t('runs.sentence.finished_with', 'Finished with "{step}"', { step });
    return oneLine(run.summary) || t('runs.sentence.finished', 'Finished');
}

/** One phrasing per outcome code; params come from the server. */
const BY_CODE: Record<string, Sentence> = {
    success: (t, run) => {
        const core = successCore(t, run);
        const handled = Number(run.outcome?.params?.handled) || 0;
        if (!handled) return core;
        const note = handled === 1
            ? t('runs.sentence.handled_one', '1 step error handled')
            : t('runs.sentence.handled_other', '{n} step errors handled', { n: handled });
        return `${core} (${note})`;
    },
    stopped_at: (t, run) => {
        const step = param(run, 'step');
        const reason = stopReason(t, run);
        if (step && reason) return t('runs.sentence.stopped_at', 'Stopped at "{step}": {cause}', { step, cause: reason });
        if (step) return t('runs.sentence.stopped_at_step', 'Stopped at "{step}"', { step });
        if (reason) return t('runs.sentence.failed_because', 'Stopped: {cause}', { cause: reason });
        return oneLine(run.outcome?.text) || t('runs.sentence.stopped', 'Stopped before it finished');
    },
    waiting_approval: (t, run) => (param(run, 'who')
        ? t('runs.sentence.waiting_approval_from', 'Waiting for approval from {who}', { who: param(run, 'who') })
        : t('runs.sentence.waiting_approval', 'Waiting for approval')),
    waiting_form: (t) => t('runs.sentence.waiting_form', 'Waiting for the next form page to be filled in'),
    waiting_confirm: (t) => t('runs.sentence.waiting_confirm', 'Waiting for someone to confirm the first run'),
    cancelled: (t, run) => (param(run, 'reasonCode') === 'already_running'
        ? t('runs.sentence.skipped_busy', 'Skipped because the automation was already running')
        : t('runs.sentence.cancelled', 'Stopped before it finished')),
};

/** Rows without an outcome: phrase the status instead. */
const BY_TONE: Record<RunTone, Sentence> = {
    error: (t, run) => (oneLine(run.error)
        ? t('runs.sentence.failed_because', 'Stopped: {cause}', { cause: oneLine(run.error) })
        : t('runs.sentence.stopped', 'Stopped before it finished')),
    success: (t, run) => oneLine(run.summary) || t('runs.sentence.finished', 'Finished'),
    running: (t) => t('runs.sentence.running', 'Still running'),
    waiting: (t, run) => {
        if (run.status === 'awaiting_form') return t('runs.sentence.waiting_form', 'Waiting for the next form page to be filled in');
        if (run.status === 'awaiting_confirm') return t('runs.sentence.waiting_confirm', 'Waiting for someone to confirm the first run');
        return t('runs.sentence.waiting_approval', 'Waiting for approval');
    },
    neutral: (t, run) => (String(run.status) === 'cancelled'
        ? t('runs.sentence.cancelled', 'Stopped before it finished')
        : oneLine(run.summary) || t('runs.sentence.finished', 'Finished')),
};

/** The one sentence that says what a run did. */
export function runSentence(t: TranslateFn, run: RunRowData): string {
    const code = run.outcome?.code;
    const byCode = code ? BY_CODE[code] : undefined;
    if (byCode) return byCode(t, run);
    // A code this build does not know: the server's own sentence.
    const text = oneLine(run.outcome?.text);
    if (text) return text;
    return BY_TONE[runTone(run)](t, run);
}

const LEGACY_HOW: Record<string, string> = {
    schedule: 'schedule', cron: 'schedule', form: 'form', form_page: 'form', webpage: 'form', webhook: 'webhook',
    agent: 'agent', agent_call: 'agent', chat: 'agent', app_event: 'app', email: 'email',
    studio_app: 'app_button', app_button: 'app_button',
};

/** Map the legacy triggerKind onto the handoff-5 howStarted vocabulary. */
export function howStartedOf(run: RunRowData): string {
    if (run.howStarted) return run.howStarted;
    return LEGACY_HOW[String(run.triggerKind || '').toLowerCase()] || 'manual';
}

interface HowWords { key: string; en: string; keyBy?: string; enBy?: string }

const HOW: Record<string, HowWords> = {
    schedule: { key: 'runs.how.schedule', en: 'on a schedule' },
    file: { key: 'runs.how.file', en: 'new file', keyBy: 'runs.how.file_by', enBy: 'new file from {who}' },
    form: { key: 'runs.how.form', en: 'form filled in', keyBy: 'runs.how.form_by', enBy: 'form filled in by {who}' },
    email: { key: 'runs.how.email', en: 'email received', keyBy: 'runs.how.email_by', enBy: 'email from {who}' },
    app: { key: 'runs.how.app', en: 'an app event' },
    webhook: { key: 'runs.how.webhook', en: 'called by another system' },
    agent: { key: 'runs.how.agent', en: 'asked from chat', keyBy: 'runs.how.agent_by', enBy: 'asked from chat by {who}' },
    app_button: { key: 'runs.how.app_button', en: 'app button', keyBy: 'runs.how.app_button_by', enBy: 'app button by {who}' },
    manual: { key: 'runs.how.manual', en: 'manually', keyBy: 'runs.how.manual_by', enBy: 'manually by {who}' },
};

/** "manually by admin", "on a schedule", "new file from m.jansen". */
export function howStartedText(t: TranslateFn, run: RunRowData): string {
    const name = run.startedBy?.name || '';
    const words = HOW[howStartedOf(run)] || HOW.manual;
    if (name && words.keyBy && words.enBy) return t(words.keyBy, words.enBy, { who: name });
    return t(words.key, words.en);
}

/** "8.9 s", "1 m 12 s", "340 ms". */
export function formatSeconds(t: TranslateFn, ms: number | null | undefined): string {
    if (ms == null || !Number.isFinite(ms)) return '';
    if (ms < 1000) return t('runs.duration.ms', '{n} ms', { n: Math.round(ms) });
    if (ms < 60_000) return t('runs.duration.s', '{n} s', { n: (ms / 1000).toFixed(1) });
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return t('runs.duration.m_s', '{m} m {s} s', { m, s });
}

/** "1 h 43 m", "12 m", "2 d 4 h": how long a waiting run has waited. */
export function formatWaited(t: TranslateFn, since: string | null | undefined, now: number = Date.now()): string {
    if (!since) return '';
    const mins = Math.max(0, Math.floor((now - new Date(since).getTime()) / 60_000));
    if (mins < 60) return t('runs.waited.m', '{m} m', { m: mins });
    const h = Math.floor(mins / 60);
    if (h < 24) return t('runs.waited.h_m', '{h} h {m} m', { h, m: mins % 60 });
    return t('runs.waited.d_h', '{d} d {h} h', { d: Math.floor(h / 24), h: h % 24 });
}

/** Per-step statuses for the little bars; empty when nothing is known. */
export function stepBars(run: RunRowData): string[] {
    if (Array.isArray(run.stepStatuses) && run.stepStatuses.length) return run.stepStatuses;
    const total = Number(run.stepsTotal) || 0;
    if (!total) return [];
    const done = Math.min(Number(run.stepsDone) || 0, total);
    const tone = runTone(run);
    return Array.from({ length: total }, (_, i) => {
        if (i < done) return 'success';
        if (i === done && tone === 'error') return 'error';
        if (i === done && tone === 'waiting') return 'waiting';
        if (i === done && tone === 'running') return 'running';
        return 'pending';
    });
}

/** "2 of 2 steps", or "step 3 of 4" while waiting; '' when unknown. */
export function stepsText(t: TranslateFn, run: RunRowData): string {
    const bars = stepBars(run);
    const total = Number(run.stepsTotal) || bars.length;
    if (!total) return '';
    const done = run.stepsDone != null ? Number(run.stepsDone) : bars.filter(s => s === 'success').length;
    if (runTone(run) === 'waiting') return t('runs.steps_at', 'step {n} of {total}', { n: Math.min(done + 1, total), total });
    return t('runs.steps_done', '{done} of {total} steps', { done, total });
}

/** A file name or subject the run was about, from its trigger payload. */
export function runSubject(run: RunRowData): string {
    const p = run.triggerPayload as Record<string, unknown> | null | undefined;
    if (!p || typeof p !== 'object') return '';
    const file = p.file as Record<string, unknown> | undefined;
    const pick = [p.fileName, p.filename, file?.name, p.subject, p.name]
        .find(v => typeof v === 'string' && v.trim());
    if (pick) return oneLine(pick, 60);
    const path = [p.path, file?.path].find(v => typeof v === 'string' && v.trim()) as string | undefined;
    return path ? oneLine(path.split('/').filter(Boolean).pop() || path, 60) : '';
}

export interface RunDayGroup {
    key: string;
    label: string;
    runs: RunRowData[];
}

function dayKey(d: Date): string {
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/** Runs grouped per local day, newest first: "Today", "Yesterday", "Saturday 26 September". */
export function groupRunsByDay(
    t: TranslateFn, runs: RunRowData[], locale?: string, now: Date = new Date(),
): RunDayGroup[] {
    const today = dayKey(now);
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const yesterday = dayKey(y);
    const groups: RunDayGroup[] = [];
    const sorted = [...runs].sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    for (const run of sorted) {
        const d = run.startedAt ? new Date(run.startedAt) : null;
        const key = d ? dayKey(d) : 'unknown';
        let group = groups[groups.length - 1];
        if (!group || group.key !== key) {
            let label: string;
            if (!d) label = t('runs.day.unknown', 'Unknown date');
            else if (key === today) label = t('runs.day.today', 'Today');
            else if (key === yesterday) label = t('runs.day.yesterday', 'Yesterday');
            else label = d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
            group = { key, label, runs: [] };
            groups.push(group);
        }
        group.runs.push(run);
    }
    return groups;
}

/** "10:55" in the viewer's locale. */
export function clockTime(iso: string | null | undefined, locale?: string, seconds = false): string {
    if (!iso) return '';
    return new Date(iso).toLocaleTimeString(locale, {
        hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}),
    });
}

/** "Today 10:55 · 8.9 s · manually by admin · version 5 · test run". */
export function runMeta(t: TranslateFn, run: RunRowData, locale?: string, now: Date = new Date()): string {
    const when = run.startedAt ? new Date(run.startedAt) : null;
    let whenText = '';
    if (when && when.toDateString() === now.toDateString()) {
        whenText = t('runs.tab.today_at', 'Today {time}', { time: clockTime(run.startedAt, locale) });
    } else if (when) {
        whenText = when.toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }
    return [
        whenText,
        formatSeconds(t, run.durationMs),
        howStartedText(t, run),
        run.version != null ? t('runs.tab.version_n', 'version {n}', { n: run.version }) : '',
        run.isTest || run.mode === 'dry_run' ? t('runs.tab.test_run', 'test run') : '',
    ].filter(Boolean).join(' · ');
}
