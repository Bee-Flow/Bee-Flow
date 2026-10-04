/**
 * The run status vocabulary: one table from status word to label, tone and
 * glyph, plus the skip nuance for recorded steps.
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
 * has a catalogue too (src/core/i18n), and a table that handed out English would
 * make every status on every screen untranslatable.
 */

import type { TranslateFn } from '@/core/i18n';
import type { IconName } from '@/shared/ui';

import type { AutomationRunStep, RunStatus } from './types';

/** The UI kit's tones this table uses (`Tone` in shared/ui/tones.ts). */
export type StatusTone = 'neutral' | 'success' | 'warning' | 'error' | 'pinned' | 'ai';

export interface StatusToken {
    /** i18n key — render with `statusLabel(t, token)`, never raw. */
    labelKey: string;
    /** English fallback, passed as the translator's second argument. */
    labelEn: string;
    tone: StatusTone;
    /** The web table's Lucide glyph for the status (statusLockstep.test.ts checks it). */
    icon: IconName;
    /** True while the run is still moving — the caller may animate or poll. */
    live: boolean;
}

const TOKENS: Record<string, StatusToken> = {
    success: { labelKey: 'run_status.success', labelEn: 'Finished', tone: 'success', icon: 'CircleCheck', live: false },
    error: { labelKey: 'run_status.error', labelEn: 'Failed', tone: 'error', icon: 'CircleX', live: false },
    // Blue, not amber: doing work is not a warning, and while it was one the
    // colour that should mean "look at this" was on the commonest state there
    // is. `ai` is the step-family blue, not the org's brandable accent.
    running: { labelKey: 'run_status.running', labelEn: 'Running', tone: 'ai', icon: 'LoaderCircle', live: true },
    queued: { labelKey: 'run_status.queued', labelEn: 'Waiting to start', tone: 'neutral', icon: 'Clock', live: true },
    // Neutral, like `queued` — neither is doing anything and neither is a
    // problem. The glyph and the word are what tell them apart.
    paused: { labelKey: 'run_status.paused', labelEn: 'Paused', tone: 'neutral', icon: 'Pause', live: false },
    cancelled: { labelKey: 'run_status.cancelled', labelEn: 'Stopped', tone: 'neutral', icon: 'Power', live: false },
    awaiting_approval: { labelKey: 'run_status.awaiting_approval', labelEn: 'Waiting for approval', tone: 'warning', icon: 'ShieldQuestionMark', live: true },
    awaiting_form: { labelKey: 'run_status.awaiting_form', labelEn: 'Waiting for a form', tone: 'warning', icon: 'ClipboardList', live: true },
    // A step that never ran because it is switched off — a setting, not an
    // outcome, and never a reason to colour an automation.
    skipped: { labelKey: 'run_status.skipped', labelEn: 'Skipped', tone: 'neutral', icon: 'CircleMinus', live: false },
    // A step that DID run and found nothing to do. The one skip worth amber.
    nothing_to_do: { labelKey: 'run_status.nothing_to_do', labelEn: 'Nothing to do', tone: 'warning', icon: 'TriangleAlert', live: false },
    handled_error: { labelKey: 'run_status.handled_error', labelEn: 'Recovered', tone: 'warning', icon: 'ShieldCheck', live: false },
    pinned: { labelKey: 'run_status.pinned', labelEn: 'Frozen data', tone: 'pinned', icon: 'Pin', live: false },
    // `pinned`'s twin: the author TYPED this payload instead of capturing it.
    // Same tone, different word — a fabricated value must never read as a real
    // capture. The step editor's Output pane makes one (flow-editor
    // nodeEditor/outputEdit.ts); it lives here because the two tables must
    // hold the same statuses (statusLockstep.test.ts).
    edited: { labelKey: 'run_status.edited', labelEn: 'Edited', tone: 'pinned', icon: 'Pencil', live: false },
    warning: { labelKey: 'run_status.warning', labelEn: 'Warning', tone: 'warning', icon: 'TriangleAlert', live: false },
    info: { labelKey: 'run_status.info', labelEn: 'Info', tone: 'ai', icon: 'Info', live: false },
    idle: { labelKey: 'run_status.idle', labelEn: 'Idle', tone: 'neutral', icon: 'Clock', live: false },
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
 *               amber here puts every automation with one disabled node
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
