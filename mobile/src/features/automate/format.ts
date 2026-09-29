/**
 * Presentation helpers for the Automate tab: status vocabulary, durations,
 * and the small cron dialect a phone is allowed to edit.
 *
 * The status table is a port of agent-hub/src/components/shared/statusTokens.ts
 * — the same statuses, the same i18n keys, the same aliases, the same "unknown
 * degrades to idle" rule, the same split between the two kinds of skip. It is
 * duplicated rather than derived for the same reason tokens.ts is: there is no
 * build step that could share a Lucide-and-Tailwind table with a React Native
 * StyleSheet, and a phone that invents its own word for `error` makes two
 * screens of one product disagree about what happened. statusLockstep.test.ts
 * reads the web table and fails when the two drift.
 *
 * Two things this port used to get wrong, both now pinned by that test:
 *   - `pinned` and `info` were simply missing, so a pinned step read as "Idle"
 *     on the phone and as "Frozen data" on the desktop;
 *   - `running` and `paused` shared one warning tone, so a schedule doing work
 *     right now and one somebody had switched off looked the same — while the
 *     Cowork tab three files away already drew a paused schedule grey.
 *
 * Labels leave as a KEY plus its English, never as a finished word: the phone
 * has a catalogue too (src/i18n), and a table that handed out English would
 * make every status on every screen untranslatable.
 */

import type { Feather } from '@expo/vector-icons';

import type { AutomationRunStep, AutomationTrigger, RunStatus } from './types';
import type { TranslateFn } from '../../i18n';

export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'accent' | 'ai';

export interface StatusToken {
    /** i18n key — render with `statusLabel(t, token)`, never raw. */
    labelKey: string;
    /** English fallback, passed as the translator's second argument. */
    labelEn: string;
    tone: StatusTone;
    icon: keyof typeof Feather.glyphMap;
    /** True while the run is still moving — the caller may animate or poll. */
    live: boolean;
}

const TOKENS: Record<string, StatusToken> = {
    success: { labelKey: 'run_status.success', labelEn: 'Finished', tone: 'success', icon: 'check-circle', live: false },
    error: { labelKey: 'run_status.error', labelEn: 'Failed', tone: 'error', icon: 'x-circle', live: false },
    // Blue, not amber: doing work is not a warning, and while it was one the
    // colour that should mean "look at this" was on the commonest state there
    // is. `ai` is the step-family blue, not the org's brandable accent.
    running: { labelKey: 'run_status.running', labelEn: 'Running', tone: 'ai', icon: 'loader', live: true },
    queued: { labelKey: 'run_status.queued', labelEn: 'Waiting to start', tone: 'neutral', icon: 'clock', live: true },
    // Neutral, like `queued` — neither is doing anything and neither is a
    // problem. The glyph and the word are what tell them apart.
    paused: { labelKey: 'run_status.paused', labelEn: 'Paused', tone: 'neutral', icon: 'pause-circle', live: false },
    cancelled: { labelKey: 'run_status.cancelled', labelEn: 'Stopped', tone: 'neutral', icon: 'power', live: false },
    awaiting_approval: { labelKey: 'run_status.awaiting_approval', labelEn: 'Waiting for approval', tone: 'warning', icon: 'shield', live: true },
    awaiting_form: { labelKey: 'run_status.awaiting_form', labelEn: 'Waiting for a form', tone: 'warning', icon: 'clipboard', live: true },
    // A step that never ran because it is switched off — a setting, not an
    // outcome, and never a reason to colour a routine.
    skipped: { labelKey: 'run_status.skipped', labelEn: 'Skipped', tone: 'neutral', icon: 'minus-circle', live: false },
    // A step that DID run and found nothing to do. The one skip worth amber.
    nothing_to_do: { labelKey: 'run_status.nothing_to_do', labelEn: 'Nothing to do', tone: 'warning', icon: 'alert-triangle', live: false },
    handled_error: { labelKey: 'run_status.handled_error', labelEn: 'Recovered', tone: 'warning', icon: 'shield', live: false },
    pinned: { labelKey: 'run_status.pinned', labelEn: 'Frozen data', tone: 'accent', icon: 'anchor', live: false },
    // `pinned`'s twin: the author TYPED this payload instead of capturing it.
    // Same tone, different word — a fabricated value must never read as a real
    // capture. Only the desktop builder can produce one; it lives here because
    // the two tables must hold the same statuses (statusLockstep.test.ts).
    edited: { labelKey: 'run_status.edited', labelEn: 'Edited', tone: 'accent', icon: 'edit-3', live: false },
    warning: { labelKey: 'run_status.warning', labelEn: 'Warning', tone: 'warning', icon: 'alert-triangle', live: false },
    info: { labelKey: 'run_status.info', labelEn: 'Info', tone: 'ai', icon: 'info', live: false },
    idle: { labelKey: 'run_status.idle', labelEn: 'Idle', tone: 'neutral', icon: 'clock', live: false },
};

/**
 * Read a table entry only when the table itself declares it.
 *
 * `TOKENS['constructor']` and `TOKENS['__proto__']` are truthy on every object
 * literal, so a plain lookup answers a question about Object.prototype: the
 * `?? idle` never fired and the caller got back the Object constructor, whose
 * `.tone` and `.labelKey` are undefined. Not reachable from today's server
 * enum — reachable the moment a status word arrives from a deep link, a saved
 * filter or a pasted definition. Same guard as the web table's `own()`.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The `idle` fallback is the whole point — never throw on a new server state. */
export function statusToken(status: RunStatus | null | undefined): StatusToken {
    const idle = TOKENS.idle as StatusToken;
    if (!status) return idle;
    const lower = String(status).toLowerCase();
    // Server-side aliases, same three the web table maps.
    if (lower === 'failed') return TOKENS.error as StatusToken;
    if (lower === 'awaiting_confirm') return TOKENS.awaiting_approval as StatusToken;
    if (lower === 'paused_breakpoint') return TOKENS.paused as StatusToken;
    return own(TOKENS, lower) ?? idle;
}

/** The token's word, translated. `t` comes from `useTranslation()`. */
export function statusLabel(t: TranslateFn, token: StatusToken): string {
    return t(token.labelKey, token.labelEn);
}

/** True for a run that has not settled — drives polling and the live region. */
export function isLiveStatus(status: RunStatus | null | undefined): boolean {
    return statusToken(status).live;
}

// ── Skips: which grey, which amber ──────────────────────────────────

/**
 * What a skip means, per reason code — the same table as the web's
 * SKIP_REASONS, and pinned against it.
 *
 *   configured  the step never ran because it is switched off. Grey, always:
 *               amber here puts every routine with one disabled node
 *               permanently on amber, and a warning that is always on is not
 *               a warning.
 *   no_work     the step ran and had nothing to do — an empty summary, a
 *               source list that did not resolve. An outcome, and worth amber.
 *   pinned      not a skip in the UI at all; it gets its own status.
 */
export type SkipGroup = 'configured' | 'no_work' | 'pinned';

export const SKIP_REASONS: Readonly<Record<string, SkipGroup>> = Object.freeze({
    disabled: 'configured',
    note: 'configured',
    arrayref_unresolved: 'no_work',
    overref_unresolved: 'no_work',
    aggregate_field_absent: 'no_work',
    summarize_field_absent: 'no_work',
    datetime_unresolved_input: 'no_work',
    datatable_column_unknown: 'no_work',
    datatable_filter_unresolved: 'no_work',
    datatable_values_unresolved: 'no_work',
    knowledge_write_empty: 'no_work',
    knowledge_write_no_kb: 'no_work',
    knowledge_write_too_long: 'no_work',
    knowledge_write_refused: 'no_work',
    no_service_email: 'no_work',
    no_owner_email: 'no_work',
    not_sent: 'no_work',
    pinned: 'pinned',
});

/** As much of a recorded step row as the status table reads. */
export interface RunStepLike {
    status?: string | null;
    /** The runner's code. Not persisted yet — see skipGroupOfStep. */
    skippedReason?: string | null;
    output?: unknown;
}

/**
 * Which group a recorded skip belongs to, or null when the row cannot say.
 *
 * `skippedReason` wins whenever it is there. It is not persisted yet
 * (recordRunStep has no parameter for it), so until then the row's SHAPE
 * carries the same fact: `output.disabled === true` is what the runner emits
 * for a switched-off step and only for that, and `output.skipped` is a string
 * on every no-work path and on none of the others. Its PRESENCE is the signal
 * — the sentence itself is never read, because a colour decided by parsing
 * English breaks on the first rewrite or translation.
 */
export function skipGroupOfStep(step: RunStepLike | AutomationRunStep | null | undefined): SkipGroup | null {
    const reason = (step as RunStepLike | null)?.skippedReason;
    const known = reason ? own(SKIP_REASONS, String(reason).toLowerCase()) : undefined;
    if (known) return known;
    const output = step?.output;
    if (output && typeof output === 'object') {
        const shape = output as { disabled?: unknown; skipped?: unknown };
        if (shape.disabled === true) return 'configured';
        if (typeof shape.skipped === 'string' && shape.skipped.trim()) return 'no_work';
    }
    return null;
}

/** The token a skip group wears. Unknown → the neutral `skipped` token. */
export function tokenForSkip(group: SkipGroup | null | undefined): StatusToken {
    if (group === 'no_work') return TOKENS.nothing_to_do as StatusToken;
    if (group === 'pinned') return TOKENS.pinned as StatusToken;
    return TOKENS.skipped as StatusToken;
}

/**
 * The token for a recorded STEP row — `statusToken` plus the skip nuance.
 * Every surface that draws a step should use this; `statusToken` is for a run.
 */
export function tokenForStep(step: RunStepLike | AutomationRunStep | null | undefined): StatusToken {
    const status = step?.status ? String(step.status).toLowerCase() : '';
    if (status !== 'skipped') return statusToken(step?.status as RunStatus | null | undefined);
    return tokenForSkip(skipGroupOfStep(step));
}

/**
 * "Today at 09:00", "Tomorrow at 09:00", "12 Mar at 09:00" — the shape
 * agent-hub's formatNextRun uses, so a schedule reads the same on both
 * clients. Past times are phrased as such rather than silently looking future.
 */
export function absoluteTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '—';
    const time = dt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    const now = new Date();
    const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
    if (sameDay(dt, now)) return `Today at ${time}`;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    if (sameDay(dt, tomorrow)) return `Tomorrow at ${time}`;
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    if (sameDay(dt, yesterday)) return `Yesterday at ${time}`;
    return `${dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} at ${time}`;
}

/**
 * "400ms", "9.5s", "12s", "3m 04s", "1h 12m". Null durations read as an em
 * dash. (This line used to claim 400ms rendered as "0.4s"; it never has —
 * anything under a second is reported in milliseconds. The test pins it.)
 *
 * NOT the shared helper. features/recording/format.ts has a function of the
 * same name that the de-duplication pass deliberately kept separate: it takes
 * SECONDS and renders a clock ("1:05:30") for media positions, where this one
 * takes MILLISECONDS and renders a spoken elapsed for how long a run took.
 * Neither generalises to the other — a clock cannot say "0.4s", and a spoken
 * elapsed cannot be a transcript timecode.
 *
 * The unit is the trap: both are `(number | null | undefined) => string`, so
 * importing the wrong one type-checks and silently renders a 90-second
 * recording as "90ms". Import it from the feature whose screen you are on.
 */
export function formatDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || Number.isNaN(ms)) return '—';
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    const total = Math.round(ms / 1000);
    if (total < 60) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Elapsed time of a run, whether or not it has finished.
 *
 * `durationMs` is only written when the run settles, so a running row would
 * otherwise show "—" for as long as it is interesting.
 */
export function runElapsedMs(run: {
    durationMs: number | null;
    startedAt: string | null;
    finishedAt: string | null;
}): number | null {
    if (typeof run.durationMs === 'number') return run.durationMs;
    if (!run.startedAt) return null;
    const start = new Date(run.startedAt).getTime();
    if (Number.isNaN(start)) return null;
    const end = run.finishedAt ? new Date(run.finishedAt).getTime() : Date.now();
    return Math.max(0, end - start);
}

// ── Triggers ────────────────────────────────────────────────────────

/**
 * One line saying what starts this routine. A port of
 * server/automation/summarise.js describeTrigger(), minus its markdown —
 * the phone reads it aloud to a screen reader, and backticks do not read.
 */
export function describeTrigger(trigger: AutomationTrigger | null | undefined): string {
    if (!trigger) return 'Runs when you start it';
    switch (trigger.kind) {
        case 'schedule':
            return describeCron(trigger.schedule?.cron ?? null, trigger.schedule?.tz ?? null);
        case 'manual':
            return 'Runs when you start it';
        case 'webhook':
            return 'Runs when its webhook URL is called';
        case 'form':
            return 'Runs when someone submits its form';
        case 'agent_call':
            return 'Runs when an AI agent calls it';
        case 'app_event': {
            const provider = trigger.appEvent?.provider ?? 'an app';
            const event = trigger.appEvent?.event ?? 'an event';
            const filtered = trigger.appEvent?.filter ? ', filtered' : '';
            return `Runs on ${provider} “${event}”${filtered}`;
        }
        default:
            return trigger.kind ? `Runs on ${trigger.kind}` : 'Runs when you start it';
    }
}

/** The Feather glyph for a trigger kind — the leading mark of every row. */
export function triggerIcon(kind: string | null | undefined): keyof typeof Feather.glyphMap {
    switch (kind) {
        case 'schedule':
            return 'clock';
        case 'webhook':
            return 'link';
        case 'form':
            return 'clipboard';
        case 'agent_call':
            return 'cpu';
        case 'app_event':
            return 'inbox';
        default:
            return 'play';
    }
}

// ── The cron dialect a phone may edit ───────────────────────────────
//
// The desktop builder writes any 5-field expression server/automation/cron.js
// accepts. A phone offers five shapes and nothing else, because a cron field
// editor on a 6" screen is a way to break a live routine by accident. Anything
// outside these five round-trips untouched and is shown read-only — see
// SchedulePicker.tsx.

export type SimpleScheduleKind = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface SimpleSchedule {
    kind: SimpleScheduleKind;
    /** 0–59. The only field `hourly` uses. */
    minute: number;
    /** 0–23. Unused by `hourly`. */
    hour: number;
    /** 0 (Sunday) – 6. `weekly` only. */
    weekday: number;
    /** 1–28. `monthly` only, capped so February always has the day. */
    day: number;
}

export const DEFAULT_SIMPLE_SCHEDULE: SimpleSchedule = {
    kind: 'daily',
    minute: 0,
    hour: 9,
    weekday: 1,
    day: 1,
};

export const WEEKDAY_NAMES = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
] as const;

export function cronFromSimple(s: SimpleSchedule): string {
    const m = clamp(s.minute, 0, 59);
    const h = clamp(s.hour, 0, 23);
    switch (s.kind) {
        case 'hourly':
            return `${m} * * * *`;
        case 'daily':
            return `${m} ${h} * * *`;
        case 'weekdays':
            return `${m} ${h} * * 1-5`;
        case 'weekly':
            return `${m} ${h} * * ${clamp(s.weekday, 0, 6)}`;
        case 'monthly':
            return `${m} ${h} ${clamp(s.day, 1, 28)} * *`;
    }
}

/**
 * Recognise one of our own five shapes. Returns null for anything else —
 * including expressions that are perfectly valid but that the picker cannot
 * represent, which is precisely when it must refuse to touch them.
 */
export function simpleFromCron(cron: string | null | undefined): SimpleSchedule | null {
    if (!cron) return null;
    const parts = cron.trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const [min, hour, dom, month, dow] = parts as [string, string, string, string, string];
    if (month !== '*') return null;

    const m = numeric(min);
    if (m === null) return null;

    if (hour === '*' && dom === '*' && dow === '*') {
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'hourly', minute: m };
    }
    const h = numeric(hour);
    if (h === null) return null;

    if (dom === '*' && dow === '*') {
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'daily', minute: m, hour: h };
    }
    if (dom === '*' && dow === '1-5') {
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'weekdays', minute: m, hour: h };
    }
    if (dom === '*') {
        const d = numeric(dow);
        // 7 is Sunday too — cron.js folds it, so the picker must as well.
        if (d === null || d > 7) return null;
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'weekly', minute: m, hour: h, weekday: d === 7 ? 0 : d };
    }
    if (dow === '*') {
        const day = numeric(dom);
        if (day === null || day < 1 || day > 28) return null;
        return { ...DEFAULT_SIMPLE_SCHEDULE, kind: 'monthly', minute: m, hour: h, day };
    }
    return null;
}

/** Human text for any cron. Falls back to the expression itself, verbatim. */
export function describeCron(cron: string | null | undefined, tz?: string | null): string {
    if (!cron) return 'On a schedule that has not been set';
    const simple = simpleFromCron(cron);
    const zone = tz ? ` (${tz})` : '';
    if (!simple) return `On a custom schedule: ${cron}${zone}`;
    const at = `${pad(simple.hour)}:${pad(simple.minute)}`;
    switch (simple.kind) {
        case 'hourly':
            return `Every hour at :${pad(simple.minute)}${zone}`;
        case 'daily':
            return `Every day at ${at}${zone}`;
        case 'weekdays':
            return `Every weekday at ${at}${zone}`;
        case 'weekly':
            return `Every ${WEEKDAY_NAMES[simple.weekday] ?? 'week'} at ${at}${zone}`;
        case 'monthly':
            return `Day ${simple.day} of each month at ${at}${zone}`;
    }
}

export function pad(n: number): string {
    return String(n).padStart(2, '0');
}

function clamp(n: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, Math.round(n)));
}

function numeric(field: string): number | null {
    if (!/^\d+$/.test(field)) return null;
    return parseInt(field, 10);
}

// ── Misc ────────────────────────────────────────────────────────────

/**
 * Render a step's output for reading. Objects are pretty-printed and clipped:
 * a run step can carry a whole API response, and a 40 KB blob in a ScrollView
 * is a dropped frame plus a wall the eye slides off.
 */
export function previewValue(value: unknown, maxChars = 1200): string | null {
    if (value === null || value === undefined) return null;
    let text: string;
    if (typeof value === 'string') text = value;
    else {
        try {
            text = JSON.stringify(value, null, 2);
        } catch {
            return null;
        }
    }
    text = text.trim();
    if (!text) return null;
    return text.length > maxChars ? `${text.slice(0, maxChars)}\n…` : text;
}

/**
 * What a step's output IS, so it can be drawn instead of dumped.
 *
 * `previewValue` above pretty-prints every non-string output as JSON. That is
 * honest and it is unreadable: the commonest thing a routine step produces is
 * a LIST OF ROWS — the results of a search, the rows of a datatable, the files
 * in a folder — and a person reading a run on their phone gets two braces and
 * a wall of quoted keys where the web builder shows them a table. Web's
 * OutputView has offered Fields / Table / JSON for a while, defaulting away
 * from JSON; mobile never got the same treatment, so the same run reads
 * completely differently depending on which screen you opened it on.
 *
 * This is the classifier half, kept pure and here so it can be unit-tested
 * without a renderer. The component that draws it lives in
 * components/ValuePreview.tsx.
 *
 * Deliberately conservative about what counts as a TABLE. Rows must be plain
 * objects sharing a key set; the moment they disagree, or a cell holds
 * something that is not a scalar, it is not a table any more and falls back
 * rather than inventing empty columns or stringifying a nested object into a
 * cell. A wrong table is worse than honest JSON, because it looks authoritative.
 */

/** A cell we are willing to print inside a table. */
type Scalar = string | number | boolean | null;

export type ValueShape =
    | { kind: 'empty' }
    | { kind: 'scalar'; text: string }
    | { kind: 'list'; items: string[]; total: number }
    | { kind: 'record'; fields: { key: string; value: string }[] }
    | { kind: 'rows'; columns: string[]; rows: string[][]; total: number }
    | { kind: 'raw'; text: string };

/** Rows beyond this are counted, not drawn — a phone list is not a spreadsheet. */
export const MAX_PREVIEW_ROWS = 20;
/** Wider than this and the columns become unreadable slivers. */
export const MAX_PREVIEW_COLUMNS = 6;

function isScalar(v: unknown): v is Scalar {
    return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** How a scalar reads in a cell. `null` is a WORD, not an empty cell: an
 *  absent value and a blank string are different facts about the data. */
function cellText(v: Scalar): string {
    if (v === null) return '—';
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
}

export function describeValue(value: unknown): ValueShape {
    if (value === null || value === undefined) return { kind: 'empty' };
    if (isScalar(value)) {
        const text = String(value).trim();
        return text ? { kind: 'scalar', text } : { kind: 'empty' };
    }

    if (Array.isArray(value)) {
        if (value.length === 0) return { kind: 'empty' };

        // A list of rows: every element a plain object, all sharing the first
        // one's keys. Anything less and it is not a table.
        if (value.every(isPlainObject)) {
            const first = value[0] as Record<string, unknown>;
            const columns = Object.keys(first).slice(0, MAX_PREVIEW_COLUMNS);
            const sameShape = value.every(
                (r) => columns.every((c) => c in (r as Record<string, unknown>)),
            );
            const allScalar = value
                .slice(0, MAX_PREVIEW_ROWS)
                .every((r) => columns.every((c) => isScalar((r as Record<string, unknown>)[c])));
            if (columns.length && sameShape && allScalar) {
                const rows = value
                    .slice(0, MAX_PREVIEW_ROWS)
                    .map((r) => columns.map((c) => cellText((r as Record<string, unknown>)[c] as Scalar)));
                return { kind: 'rows', columns, rows, total: value.length };
            }
        }

        if (value.every(isScalar)) {
            return {
                kind: 'list',
                items: value.slice(0, MAX_PREVIEW_ROWS).map((v) => cellText(v as Scalar)),
                total: value.length,
            };
        }

        return { kind: 'raw', text: previewValue(value) ?? '' };
    }

    if (isPlainObject(value)) {
        const entries = Object.entries(value);
        // An object with no keys has nothing to say. Falling through to `raw`
        // would print a literal "{}" in a box, which reads as a value rather
        // than as the absence of one.
        if (entries.length === 0) return { kind: 'empty' };
        // Only a FLAT record reads as fields. One nested object and the eye
        // needs the structure, so hand it to the raw view rather than printing
        // "[object Object]" next to a label.
        if (entries.every(([, v]) => isScalar(v))) {
            return { kind: 'record', fields: entries.map(([key, v]) => ({ key, value: cellText(v as Scalar) })) };
        }
        return { kind: 'raw', text: previewValue(value) ?? '' };
    }

    return { kind: 'raw', text: previewValue(value) ?? '' };
}
