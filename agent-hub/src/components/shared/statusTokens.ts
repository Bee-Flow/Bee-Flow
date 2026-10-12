import {
    AlertTriangle,
    CheckCircle2,
    ClipboardList,
    Clock,
    Info,
    Loader2,
    MinusCircle,
    Pause,
    Pencil,
    Pin,
    Power,
    ShieldCheck,
    ShieldQuestion,
    XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * Status token table — single source of truth for the colours, icons, and
 * words used to render automation/run/step status across the studio.
 *
 * Until now every component rolled its own emerald/amber/red Tailwind
 * mix. That made theme work painful (every new shade had to be hunted
 * down) and made consistency impossible — "success" was emerald-500 in
 * one place, green-600 in another, and a custom hex in a third. The
 * table here is the only place that maps a semantic status name to its
 * visual treatment.
 *
 * That sentence was aspirational until 2026-09-06: RunTabContainer (the node
 * inspector's Run tab) and AutomationsStudio/AutomationRow (the sidebar status dot)
 * each kept a private emerald/amber/red ladder, and the node inspector printed
 * a raw `awaiting_approval` at the user.
 *
 * The canvas was the third surface, and the one that made fixing the other two
 * read as a bug: its own table (automation/Builder/flow/nodeTypeColors.js)
 * painted a running card amber — the SAME amber as `paused`, CW-04 all over
 * again — while the run panel beside it drew that step blue. One view
 * disagreeing with itself is worse than two screens disagreeing, because the
 * user sees both halves at once. It reads this table now as well, through
 * `cssVar`: a card border is an inline style, so the canvas needs the bare
 * token rather than a class string.
 *
 * If you are about to write another `switch (status)`, this is the thing you
 * are looking for — `tokenForStep(row)` when you hold the row, `tokenFor(word)`
 * when all you have is the word, and `.cssVar` off either when you are
 * painting with a style object.
 *
 * Three things this table is NOT:
 *
 *   - it is not `shared/statusOf.js`. That module owns the Studio's
 *     "is this thing live?" vocabulary (live/paused/draft/published/
 *     stale/unknown) and is painted by `shared/StatusActionPill`. The two
 *     share the WORD `paused` with different meanings: there it means "this
 *     automation is switched off", here it means "this run is paused". Hence
 *     the separate `run_status.*` namespace — a shared key would make one
 *     translator's choice wrong on one of the two screens.
 *   - it is not a palette. Every colour is a `var(--token)` from index.css,
 *     never a Tailwind palette class and never a hex: a hard-coded
 *     `text-amber-600` does not follow the eight themes, and index.css is
 *     where the contrast work lives.
 *   - it is not a dictionary. A row carries an i18n KEY plus its English
 *     fallback; the consumer translates (`statusLabel(t, token)`). A pure,
 *     React-free module cannot call a hook, and a table that handed out
 *     finished English would make every screen that shows a status
 *     untranslatable — which is exactly how the runs table ended up
 *     rendering a Dutch sentence with an English status word inside it.
 *
 * Colour rules, from index.css:
 *   - text and icons take the `-ink` token where one exists
 *     (--success-ink / --warning-ink / --error-ink). On the light themes it
 *     is a darker step than the raw token (the raw one measures 2.7-3.8:1 as
 *     text); on the dark themes it IS the lighter shade this table used to
 *     spell as `dark:text-emerald-400`.
 *   - tints are `color-mix(…, <raw token> N%, transparent)`, never the ink.
 *   - `running` is --type-ai, the blue the builder already teaches as "AI
 *     step" and the Cowork artboard names for "Loopt". It used to be amber —
 *     the SAME amber as `paused`, so on a Cowork row "doing work right now"
 *     and "deliberately switched off" were one colour (CW-04). It also spent
 *     the warning colour on the most common state in the product, leaving
 *     nothing for the states that actually want attention.
 *   - `info` shares --type-ai with `running` on purpose: it is a banner tone,
 *     never a run state, so the two never appear in one list. A surface that
 *     ever needs both wants its own token, not a second meaning for this one.
 *
 * Token surface:
 *   - solid       — full-saturation text/icon colour for inline use
 *   - subtle      — ~10% tint for banners/cards
 *   - badge       — combined tint + ink for chip-style badges
 *   - cssVar      — the same decision as a bare `var(--token)`, for surfaces
 *                   that paint with inline styles instead of classes; null
 *                   where the state is neutral
 *   - icon        — the conventional lucide icon for this state
 *   - spin        — whether the icon should animate (running states)
 *   - labelKey    — the i18n key for this state's word
 *   - labelEn     — the English word, as the t() fallback
 *
 * Class strings are written out in full on purpose. Tailwind reads the
 * SOURCE for candidate class names, so a class assembled from a template
 * literal (`text-[var(--${tone})]`) is never generated.
 *
 * Add a new status by extending STATUS_KEYS, adding a row below, and adding
 * its `run_status.*` key to server/i18n/defaults/en/run_status.js, then
 * regenerating agent-hub/src/i18n/en-defaults.js with
 * `node scripts/gen-i18n-defaults.mjs` (i18nGuard.test.js checks they match).
 * The phone carries a hand port of this table in
 * mobile/src/features/automate/format.ts, pinned by statusLockstep.test.ts.
 */

export const STATUS_KEYS = [
    'success',
    'error',
    'running',
    'queued',
    'paused',
    'cancelled',
    'awaiting_approval',
    'awaiting_form',
    'skipped',
    'nothing_to_do',
    'handled_error',
    'pinned',
    'edited',
    'warning',
    'info',
    'idle',
] as const;

export type StatusKey = typeof STATUS_KEYS[number];

export interface StatusToken {
    solid: string;
    subtle: string;
    badge: string;
    /**
     * The raw custom property behind this row, for the surfaces that paint
     * with inline styles instead of Tailwind classes — the builder canvas
     * draws a card's border, its status ring, its pulse and its minimap
     * swatch from this one.
     *
     * RAW, never the `-ink` step: the ink is the darker (or, on the dark
     * themes, lighter) variant that keeps a WORD legible against the page,
     * while a 1.5px border is the colour itself. It is the same token
     * `subtle` and `badge` tint from — the invariant the test checks.
     *
     * `null` on the neutral rows. A canvas has no grey chrome to offer: a
     * neutral state keeps the card's ordinary border, which is exactly what
     * "this state makes no claim" looks like there.
     */
    cssVar: string | null;
    icon: LucideIcon;
    spin: boolean;
    /** i18n key — translate with `statusLabel(t, token)`, never render raw. */
    labelKey: string;
    /** English fallback, passed as t()'s second argument. */
    labelEn: string;
}

/** The neutral recipe — four states share it; see `paused` for why. */
const NEUTRAL_SOLID = 'text-[var(--text-tertiary)]';
const NEUTRAL_SUBTLE = 'bg-[var(--bg-secondary)]';
const NEUTRAL_BADGE = 'bg-[var(--bg-secondary)] text-[var(--text-secondary)]';

export const STATUS_TOKENS: Record<StatusKey, StatusToken> = {
    success: {
        solid: 'text-[var(--success-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success-ink)]',
        cssVar: 'var(--success)',
        icon: CheckCircle2,
        spin: false,
        labelKey: 'run_status.success',
        labelEn: 'Finished',
    },
    error: {
        solid: 'text-[var(--error-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--error)_15%,transparent)] text-[var(--error-ink)]',
        cssVar: 'var(--error)',
        icon: XCircle,
        spin: false,
        labelKey: 'run_status.error',
        labelEn: 'Failed',
    },
    // Blue, not amber — the one state that is neither a warning nor a
    // finished outcome. See the header note on CW-04.
    running: {
        solid: 'text-[var(--type-ai)]',
        subtle: 'bg-[color-mix(in_srgb,var(--type-ai)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--type-ai)_15%,transparent)] text-[var(--type-ai)]',
        cssVar: 'var(--type-ai)',
        icon: Loader2,
        spin: true,
        labelKey: 'run_status.running',
        labelEn: 'Running',
    },
    queued: {
        solid: NEUTRAL_SOLID,
        subtle: NEUTRAL_SUBTLE,
        badge: NEUTRAL_BADGE,
        cssVar: null,
        icon: Clock,
        spin: false,
        labelKey: 'run_status.queued',
        labelEn: 'Waiting to start',
    },
    // Neutral, and deliberately the same neutral as `queued`: the Cowork
    // artboard paints "Gepauzeerd" and "In wachtrij" in --text-tertiary
    // together, because neither is doing anything and neither is a problem.
    // The icon and the word are what tell them apart — the colour's job is
    // only to separate them from `running`, which it now does.
    paused: {
        solid: NEUTRAL_SOLID,
        subtle: NEUTRAL_SUBTLE,
        badge: NEUTRAL_BADGE,
        cssVar: null,
        icon: Pause,
        spin: false,
        labelKey: 'run_status.paused',
        labelEn: 'Paused',
    },
    cancelled: {
        solid: NEUTRAL_SOLID,
        subtle: NEUTRAL_SUBTLE,
        badge: NEUTRAL_BADGE,
        cssVar: null,
        icon: Power,
        spin: false,
        labelKey: 'run_status.cancelled',
        labelEn: 'Stopped',
    },
    awaiting_approval: {
        solid: 'text-[var(--warning-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning-ink)] border border-[color-mix(in_srgb,var(--warning)_40%,transparent)]',
        cssVar: 'var(--warning)',
        icon: ShieldQuestion,
        spin: false,
        labelKey: 'run_status.awaiting_approval',
        labelEn: 'Waiting for approval',
    },
    awaiting_form: {
        solid: 'text-[var(--warning-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning-ink)] border border-[color-mix(in_srgb,var(--warning)_40%,transparent)]',
        cssVar: 'var(--warning)',
        icon: ClipboardList,
        spin: false,
        labelKey: 'run_status.awaiting_form',
        labelEn: 'Waiting for a form',
    },
    // A step that did not run because it is switched off — a configuration
    // fact, and never a reason to colour an automation. Also the landing place
    // for a skip whose reason cannot be recovered: grey claims less.
    skipped: {
        solid: NEUTRAL_SOLID,
        subtle: NEUTRAL_SUBTLE,
        badge: NEUTRAL_BADGE,
        cssVar: null,
        icon: MinusCircle,
        spin: false,
        labelKey: 'run_status.skipped',
        labelEn: 'Skipped',
    },
    // A step that DID run and found nothing to do — an outcome, not a
    // setting. The one skip worth amber, and only ever reached through a
    // skippedReason in the `no_work` group (see SKIP_REASONS).
    nothing_to_do: {
        solid: 'text-[var(--warning-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning-ink)]',
        cssVar: 'var(--warning)',
        icon: AlertTriangle,
        spin: false,
        labelKey: 'run_status.nothing_to_do',
        labelEn: 'Nothing to do',
    },
    handled_error: {
        solid: 'text-[var(--warning-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning-ink)]',
        cssVar: 'var(--warning)',
        icon: ShieldCheck,
        spin: false,
        labelKey: 'run_status.handled_error',
        labelEn: 'Recovered',
    },
    // "Frozen data", never "Sample data" — a pinned output is REAL captured
    // data the user chose to reuse, not a placeholder.
    pinned: {
        solid: 'text-[var(--pinned)]',
        subtle: 'bg-[color-mix(in_srgb,var(--pinned)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--pinned)_15%,transparent)] text-[var(--pinned)]',
        cssVar: 'var(--pinned)',
        icon: Pin,
        spin: false,
        labelKey: 'run_status.pinned',
        labelEn: 'Frozen data',
    },
    // `pinned`'s twin, and the one status no server ever sends: the author
    // TYPED this payload instead of capturing it. It wears the same colour
    // because downstream it behaves identically, and a different WORD because
    // the two are not the same claim — a fabricated value must never read as
    // a real capture (BFSF-408). The pencil is the same glyph the Edit button
    // carries, so the badge and the button that made it match.
    edited: {
        solid: 'text-[var(--pinned)]',
        subtle: 'bg-[color-mix(in_srgb,var(--pinned)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--pinned)_15%,transparent)] text-[var(--pinned)]',
        cssVar: 'var(--pinned)',
        icon: Pencil,
        spin: false,
        labelKey: 'run_status.edited',
        labelEn: 'Edited',
    },
    warning: {
        solid: 'text-[var(--warning-ink)]',
        subtle: 'bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning-ink)]',
        cssVar: 'var(--warning)',
        icon: AlertTriangle,
        spin: false,
        labelKey: 'run_status.warning',
        labelEn: 'Warning',
    },
    info: {
        solid: 'text-[var(--type-ai)]',
        subtle: 'bg-[color-mix(in_srgb,var(--type-ai)_10%,transparent)]',
        badge: 'bg-[color-mix(in_srgb,var(--type-ai)_15%,transparent)] text-[var(--type-ai)]',
        cssVar: 'var(--type-ai)',
        icon: Info,
        spin: false,
        labelKey: 'run_status.info',
        labelEn: 'Info',
    },
    idle: {
        solid: NEUTRAL_SOLID,
        subtle: NEUTRAL_SUBTLE,
        badge: NEUTRAL_BADGE,
        cssVar: null,
        icon: Clock,
        spin: false,
        labelKey: 'run_status.idle',
        labelEn: 'Idle',
    },
};

/**
 * Read a table entry only when the table itself declares it.
 *
 * `'constructor' in ALIASES` and `TABLE['__proto__']` are both TRUE of every
 * object literal, so a plain lookup answers a question about Object.prototype
 * rather than about statuses: `tokenFor('constructor')` used to return
 * undefined (the alias branch was taken, and there is no such alias), and the
 * first call site to read `.solid` off it threw — from a function whose whole
 * contract is that it never does. Not reachable from today's server enum;
 * reachable the moment a status word comes from a URL, a saved filter or a
 * pasted definition.
 */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** Server-side spellings that mean a canonical key. */
const ALIASES: Record<string, StatusKey> = {
    failed: 'error',
    awaiting_confirm: 'awaiting_approval',
    paused_breakpoint: 'paused',
};

/** The canonical key for a raw status string, or null when there is none. */
function canonicalKey(status: string | null | undefined): StatusKey | null {
    if (!status) return null;
    const lower = String(status).toLowerCase();
    const alias = own(ALIASES, lower);
    if (alias) return alias;
    if ((STATUS_KEYS as readonly string[]).includes(lower)) return lower as StatusKey;
    return null;
}

/**
 * Look up a token by status string. Falls back to `idle` for anything
 * outside the canonical set so call sites can safely pass through
 * unknown server-side statuses without crashing — they'll just render
 * as the neutral idle token.
 *
 * A recorded STEP row should go through `tokenForStep` instead: a bare
 * `'skipped'` carries no reason, and this function will not guess one.
 */
export function tokenFor(status: string | null | undefined): StatusToken {
    const key = canonicalKey(status);
    return key ? STATUS_TOKENS[key] : STATUS_TOKENS.idle;
}

/**
 * The token's word, translated. Pure — `t` arrives as an argument so this
 * module stays React-free and the i18n guard still sees the keys (they are
 * `labelKey:` carriers in the table above). Same shape as
 * `StatusActionPill.statusWord`.
 */
export function statusLabel(
    t: (key: string, fallback: string) => string,
    token: StatusToken,
): string {
    return t(token.labelKey, token.labelEn);
}

// ── Skips: which grey, which amber ──────────────────────────────────

/**
 * What a skip MEANS, per reason code.
 *
 *   configured  the step never ran because someone switched it off. A
 *               configuration fact. Grey, always: colouring it would put
 *               every automation that has one disabled node permanently on
 *               amber, and a warning that is always on is not a warning.
 *   no_work     the step ran and had nothing to do — an empty summary, a
 *               source list that did not resolve, a column that is not
 *               there. An OUTCOME, and the one the run view should show in
 *               amber: it used to pass as a green success with an empty
 *               result, which is how an automation could report "done" for
 *               weeks while writing nothing.
 *   pinned      not a skip at all in the UI — the step was replaced by
 *               frozen data and gets its own status. Listed so this table
 *               covers every code the runner can emit.
 *
 * These are the codes `server/core/automationRunner/*` sets as
 * `skippedReason`; execCollections.js calls them "the stable code tests and
 * run-history facets match on", which is exactly what makes them safe to key
 * a colour off. The runner's English sentence on `output.skipped` is NOT
 * consulted — a colour decided by parsing prose breaks the first time the
 * sentence is reworded or translated.
 */
export type SkipGroup = 'configured' | 'no_work' | 'pinned';

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
    // A flatten whose inner list is on none of the outer items.
    flatten_no_match: 'no_work',
    // execDateTime.js
    datetime_unresolved_input: 'no_work',
    // execDatatable.js
    datatable_column_unknown: 'no_work',
    datatable_filter_unresolved: 'no_work',
    datatable_values_unresolved: 'no_work',
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

/** A recorded run-step row, as much of it as this module reads. */
export interface RunStepLike {
    status?: string | null;
    /** The runner's code. Not persisted yet — see skipGroupOfStep. */
    skippedReason?: string | null;
    output?: unknown;
}

/**
 * Which group a recorded skip belongs to, or null when the row cannot say.
 *
 * `skippedReason` is the answer whenever it is there, and one day it always
 * will be: the runner sets it on every skip, but `recordRunStep`
 * (server/stores/automationStore/runs.js) has no parameter for it and
 * `automation_run_steps` has no column, so today it never reaches a client.
 *
 * Until it does, the row's SHAPE carries the same fact without anyone having
 * to read a sentence:
 *   - `output.disabled === true` is what execution.js emits for a switched-off
 *     step, and only for that;
 *   - `output.skipped` is a string on every one of the fifteen `no_work` codes
 *     and on none of the others (each exec module builds it through its own
 *     `skipped()` helper, which puts the code top-level and the sentence
 *     there). Its PRESENCE is the signal; its text is never inspected.
 * Anything else is unknown, and an unknown skip stays grey.
 */
export function skipGroupOfStep(step: RunStepLike | null | undefined): SkipGroup | null {
    const reason = step?.skippedReason;
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
    if (group === 'no_work') return STATUS_TOKENS.nothing_to_do;
    if (group === 'pinned') return STATUS_TOKENS.pinned;
    return STATUS_TOKENS.skipped;
}

/**
 * The token for a recorded run-step row — `tokenFor` plus the skip nuance.
 *
 * Every surface that renders a STEP should use this; `tokenFor` is for a RUN
 * status and for the odd caller that only has a word.
 */
export function tokenForStep(step: RunStepLike | null | undefined): StatusToken {
    if (canonicalKey(step?.status) !== 'skipped') return tokenFor(step?.status);
    return tokenForSkip(skipGroupOfStep(step));
}
