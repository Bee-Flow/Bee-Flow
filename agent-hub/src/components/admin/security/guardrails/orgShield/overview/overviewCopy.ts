import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { EVIDENCE_DAYS } from '../activity/useShieldEvidence';
import { STEP_OF } from '../orgShieldPosture';
import { ownDataSummary } from '../ownData/ownDataCopy';
import type { CustomDataType } from '../ownData/ownDataModel';
import type { GuardStatus, Posture, PostureRow } from './types';

/**
 * The Overview's words: every label, value, step title and review sentence,
 * derived from the posture rows. Pure (no React), so the copy rules — which
 * number may be shown, which wording fits which state — are unit-tested
 * without rendering.
 *
 * Two readings of the same rows share this module on purpose: the review card
 * (rows worth a second look) and the four step cards (every row, grouped by
 * where a message meets it). A setting cannot be worded one way above and
 * another way below.
 */

export type StepNo = 1 | 2 | 3 | 4;

export interface StepDef {
    n: StepNo;
    /** The tab the step card's link opens. */
    tab: string;
    titleKey: string;
    fallback: string;
}

/** The four steps of the path, titled like the strip's tabs. */
export const STEPS: readonly StepDef[] = [
    { n: 1, tab: 'detection', titleKey: 'admin.shield_tab_detection', fallback: 'What we look for' },
    { n: 2, tab: 'owndata', titleKey: 'shield_data.tab_label', fallback: 'Your own data' },
    { n: 3, tab: 'processing', titleKey: 'admin.shield_posture_action', fallback: 'When we find something' },
    { n: 4, tab: 'outbound', titleKey: 'admin.shield_tab_outbound', fallback: 'Leaving your org' },
];

/**
 * The order rows are listed in inside a card. derivePosture appends rows in
 * the order it computes them; the cards read in the order a person would
 * check them (the tool lists before the optional last check).
 */
const DISPLAY_ORDER = [
    'categories', 'sensitivity', 'allowlist',
    'customterms',
    'action', 'transparency', 'routines', 'knowledge',
    'toolcalls', 'dlp', 'eu', 'websearch',
];

const stepOf = STEP_OF as Record<string, number | undefined>;

/** The posture rows shown on one step card, in display order. */
export function rowsForStep(posture: Posture, n: StepNo): PostureRow[] {
    return posture.rows
        .filter(row => stepOf[row.id] === n)
        .sort((a, b) => DISPLAY_ORDER.indexOf(a.id) - DISPLAY_ORDER.indexOf(b.id));
}

export interface CopyContext {
    t: TranslateFn;
    /** Does the plan include the org's own kinds of data? */
    ownDataLicensed: boolean;
    customTypes: readonly CustomDataType[];
    guard: GuardStatus | null;
}

/** One label/value line on a step card. */
export interface Fact {
    id: string;
    label: string;
    value: string;
    /** The quiet half of the value ("— the tested setting"), lighter ink. */
    note?: string | null;
    /** Settings read bold; descriptions ("221 well-known companies") do not. */
    strong: boolean;
    /** Warning ink: this value is the reason a review item exists. */
    warn: boolean;
}

type Tr = [key: string, fallback: string];

const LABELS: Record<string, Tr> = {
    categories: ['shield_overview.row_kinds', 'Kinds of data'],
    sensitivity: ['admin.shield_posture_sensitivity', 'How strict'],
    allowlist: ['admin.shield_posture_allowlist', 'Never hidden'],
    customterms: ['shield_overview.row_own_types', 'Your own types'],
    action: ['shield_overview.row_action', 'Action'],
    transparency: ['admin.shield_posture_transparency', 'Show what was sent'],
    routines: ['shield_overview.row_routines', 'Routines'],
    knowledge: ['shield_overview.row_knowledge', 'Knowledge bases'],
    toolcalls: ['admin.shield_posture_toolcalls', 'Held back from tools'],
    dlp: ['shield_overview.row_last_check', 'Last check'],
    eu: ['admin.shield_posture_eu', 'EU-hosted AI only'],
    websearch: ['admin.shield_posture_websearch', 'Web search protection'],
};

/** The full name of the setting a row reports on, for "Change …" labels. */
const SETTING_NAMES: Record<string, Tr> = {
    categories: ['admin.shield_posture_categories', 'Kinds of data we look for'],
    action: ['admin.shield_posture_action', 'When we find something'],
    transparency: ['admin.shield_posture_transparency', 'Show what was sent'],
    toolcalls: ['admin.shield_posture_toolcalls', 'Held back from tools'],
    eu: ['admin.shield_posture_eu', 'EU-hosted AI only'],
    allowlist: ['admin.shield_posture_allowlist', 'Never hidden'],
    dlp: ['admin.shield_posture_dlp', 'One last check before an outside AI'],
};

export function settingName(id: string, t: TranslateFn): string {
    const tr = SETTING_NAMES[id] || LABELS[id];
    return tr ? t(tr[0], tr[1]) : id;
}

const onOff = (on: boolean | undefined, t: TranslateFn) => (on ? t('common.on', 'On') : t('common.off', 'Off'));
const covered = (on: boolean | undefined, t: TranslateFn) => (on
    ? t('shield_overview.covered', 'Covered')
    : t('shield_overview.not_covered', 'Not covered'));

type FactBody = Pick<Fact, 'value'> & Partial<Pick<Fact, 'note' | 'strong'>>;
type FactFn = (row: PostureRow, ctx: CopyContext) => FactBody;

function sensitivityFact(row: PostureRow, { t }: CopyContext): FactBody {
    const v = row.value;
    const presets: Record<string, Tr> = {
        strict: ['privacy.sensitivity_strict', 'Low sensitivity'],
        balanced: ['privacy.sensitivity_balanced', 'Balanced'],
        high: ['privacy.sensitivity_high', 'High sensitivity'],
    };
    const preset = v.presetId ? presets[v.presetId] : undefined;
    if (!preset) return { value: t('admin.shield_posture_custom_pct', 'Custom ({pct}%)', { pct: v.customPct }) };
    return {
        value: t(preset[0], preset[1]),
        note: v.presetId === 'balanced' ? t('admin.shield_posture_sensitivity_tested', '— the tested setting') : null,
    };
}

function allowlistFact(row: PostureRow, { t }: CopyContext): FactBody {
    const { terms = 0, publicOrgs } = row.value;
    let value: string;
    if (publicOrgs) {
        value = terms === 0
            ? t('shield_overview.allow_public', '221 well-known companies')
            : t('shield_overview.allow_public_own', '221 well-known companies + {n} of your own', { n: terms });
    } else {
        value = terms === 0 ? t('common.none', 'None') : t('admin.shield_posture_allow_value', '{n} of your own', { n: terms });
    }
    return { value, strong: false };
}

function ownTypesFact(row: PostureRow, ctx: CopyContext): FactBody {
    const { t } = ctx;
    // Without the licence the tab is read-only; say so the way the strip does.
    if (!ctx.ownDataLicensed) return { value: ownDataSummary(ctx.customTypes, { licensed: false, guard: ctx.guard, t }).text };
    const n = row.value.n || 0;
    if (n === 0) return { value: t('shield_overview.own_types_none', 'None yet') };
    return {
        value: n === 1 ? t('shield_data.posture_value', '{n} type', { n }) : t('shield_data.posture_value_plural', '{n} types', { n }),
        note: row.value.sample?.length ? row.value.sample.join(' · ') : null,
    };
}

function dlpFact(row: PostureRow, { t }: CopyContext): FactBody {
    const { on, mode } = row.value;
    if (!on) return { value: t('common.off', 'Off') };
    if (mode === 'block') return { value: t('admin.shield_posture_dlp_block', 'On — do not send') };
    if (mode === 'auto_redact') return { value: t('admin.shield_posture_dlp_redact', 'On — hide automatically') };
    return { value: t('admin.shield_posture_dlp_ask', 'On — ask the person') };
}

const FACTS: Record<string, FactFn> = {
    categories: (row, { t }) => ({
        value: t('admin.shield_posture_categories_value', '{n} of {total}', { n: row.value.n, total: row.value.total }),
    }),
    sensitivity: sensitivityFact,
    allowlist: allowlistFact,
    customterms: ownTypesFact,
    action: (row, { t }) => ({
        value: row.value.action === 'tokenize'
            ? t('dlp.action_tokenize_label', 'Replace with placeholders')
            : t('dlp.action_block_label', 'Do not send the message'),
    }),
    transparency: (row, { t }) => ({ value: onOff(row.value.on, t) }),
    routines: (row, { t }) => ({ value: covered(row.value.on, t) }),
    knowledge: (row, { t }) => ({ value: covered(row.value.on, t) }),
    toolcalls: (row, { t }) => ({
        value: t('shield_overview.held_back_value', '{external} of {total} outside · {internal} of {total} own server', {
            external: row.value.external, internal: row.value.internal, total: row.value.total,
        }),
    }),
    dlp: dlpFact,
    eu: (row, { t }) => ({ value: onOff(row.value.on, t) }),
    websearch: (row, { t }) => ({ value: onOff(row.value.on, t) }),
};

/**
 * Warning ink marks the value a review item is about. The transparency value
 * reads amber whenever it is on — it reveals rather than protects — which is
 * exactly when its row carries the `note` tone.
 */
const isWarnValue = (row: PostureRow) => row.tone === 'warn' || row.tone === 'error'
    || (row.id === 'transparency' && row.tone === 'note');

export function factFor(row: PostureRow, ctx: CopyContext): Fact | null {
    const fn = FACTS[row.id];
    const label = LABELS[row.id];
    if (!fn || !label) return null;
    const body = fn(row, ctx);
    return {
        id: row.id,
        label: ctx.t(label[0], label[1]),
        value: body.value,
        note: body.note ?? null,
        strong: body.strong ?? true,
        warn: isWarnValue(row),
    };
}

/**
 * A step card's lines. Step 2 adds a "Suggested" line while the org has no
 * types of its own: it names the two starters the Your own data tab already
 * offers, so it points at something that exists rather than inventing a plan.
 */
export function factsForStep(posture: Posture, n: StepNo, ctx: CopyContext): Fact[] {
    const facts = rowsForStep(posture, n).map(row => factFor(row, ctx)).filter((f): f is Fact => !!f);
    const own = posture.rows.find(r => r.id === 'customterms');
    if (n === 2 && own && ctx.ownDataLicensed && (own.value.n || 0) === 0) {
        facts.push({
            id: 'suggested',
            label: ctx.t('shield_overview.row_suggested', 'Suggested'),
            value: `${ctx.t('shield_data.starter_projects_name', 'Project code names')} · ${ctx.t('shield_data.starter_numbers_name', 'Customer numbers')}`,
            note: null,
            strong: false,
            warn: false,
        });
    }
    return facts;
}

/** A step card's link: "Add" for an empty own-data step, "Change" otherwise. */
export function stepLink(step: StepDef, posture: Posture, ctx: CopyContext): { text: string; ariaLabel: string } {
    const { t } = ctx;
    const title = t(step.titleKey, step.fallback);
    const own = posture.rows.find(r => r.id === 'customterms');
    if (step.n === 2 && ctx.ownDataLicensed && own && (own.value.n || 0) === 0) {
        return { text: t('common.add', 'Add'), ariaLabel: t('shield_overview.add_step', 'Add to {step}', { step: title }) };
    }
    return { text: t('admin.shield_posture_change', 'Change'), ariaLabel: t('shield_overview.change_step', 'Change {step}', { step: title }) };
}

// ── The review card ──────────────────────────────────────────────────────

export interface ReviewText {
    title: string;
    body: string;
}

/** "3 things to review", and what the list is based on. */
export function reviewHeading(count: number, hasEvidence: boolean, t: TranslateFn): { title: string; basis: string } {
    return {
        title: count === 1
            ? t('shield_overview.review_count', '{n} thing to review', { n: count })
            : t('shield_overview.review_count_plural', '{n} things to review', { n: count }),
        // Only claim the last 30 days when they were actually read.
        basis: hasEvidence
            ? t('shield_overview.review_basis_evidence', 'based on your settings and the last {days} days', { days: EVIDENCE_DAYS })
            : t('shield_overview.review_basis', 'based on your settings'),
    };
}

/**
 * What the last 30 days add to the tool item. Every number is optional:
 * `null` means unknown, and an unknown number is left out, never shown as 0.
 * The leak count is a subset of the calls with personal data, so it only
 * appears beside them.
 */
function toolEvidence(toolPii: number | null | undefined, leaked: number | null | undefined, t: TranslateFn): string | null {
    if (toolPii == null) return null;
    const p = { days: EVIDENCE_DAYS, n: toolPii, leaked };
    if (leaked != null && leaked > 0) {
        return toolPii === 1
            ? t('shield_overview.review_tools_left_abroad', 'In the last {days} days, {n} tool call left with personal data, to a server outside Europe.', p)
            : t('shield_overview.review_tools_left_abroad_plural', 'In the last {days} days, {n} tool calls left with personal data — {leaked} of them outside Europe.', p);
    }
    return toolPii === 1
        ? t('shield_overview.review_tools_left', 'In the last {days} days, {n} tool call left with personal data.', p)
        : t('shield_overview.review_tools_left_plural', 'In the last {days} days, {n} tool calls left with personal data.', p);
}

function toolsReview(row: PostureRow, t: TranslateFn): ReviewText {
    const { external = 0, total = 0, toolPii, leakedCount } = row.value;
    // "Any personal data" is only true while no kind at all is held back;
    // otherwise the finding is the leak itself.
    const title = external === 0
        ? t('shield_overview.review_tools_title', 'Tools may carry any personal data out')
        : t('admin.shield_activity_alert_pii_abroad', 'Personal data left Europe');
    const held = external === 0
        ? t('shield_overview.review_tools_none', 'No kind is held back from outside tools ({external} of {total}).', { external, total })
        : t('shield_overview.review_tools_some', '{external} of {total} kinds are held back from outside tools.', { external, total });
    return { title, body: [held, toolEvidence(toolPii, leakedCount, t)].filter(Boolean).join(' ') };
}

type ReviewFn = (row: PostureRow, t: TranslateFn) => ReviewText;

const REVIEWS: Record<string, ReviewFn> = {
    guard: (row, t) => ({
        title: row.value.configured === false
            ? t('shield_overview.review_guard_missing', 'The detection service is not installed')
            : t('shield_overview.review_guard_unreachable', 'The detection service is not responding'),
        body: t('admin.shield_posture_guard_hint',
            'This service does the actual scanning. Until it is running, nothing on this page has any effect.'),
    }),
    categories: (_row, t) => ({
        title: t('shield_overview.review_kinds_title', 'No kinds of data are selected'),
        body: t('admin.shield_posture_categories_hint', 'Protection is on, but nothing is ticked — so nothing will ever be found.'),
    }),
    action: (_row, t) => ({
        title: t('shield_overview.review_action_title', 'Placeholders are not in your plan'),
        body: t('admin.shield_posture_action_hint', 'Your plan does not include placeholders, so these messages are stopped instead.'),
    }),
    toolcalls: toolsReview,
    eu: (_row, t) => ({
        title: t('shield_overview.review_eu_title', 'EU-hosted AI only is off'),
        body: t('admin.shield_posture_eu_hint',
            'A chat may go to an AI model outside Europe. This is NOT about connected apps such as Gmail — you govern those with the tool columns.'),
    }),
    transparency: (_row, t) => ({
        title: t('shield_overview.review_reveal_title', 'Anyone in a conversation can reveal the real values'),
        body: t('shield_overview.review_reveal_body',
            '“Show what was sent” is on. That is useful for trust, but it also means shared conversations expose the originals.'),
    }),
    allowlist: (row, t) => ({
        title: row.value.terms === 1
            ? t('shield_overview.review_allow_title', '{n} exception of your own is never hidden', { n: row.value.terms })
            : t('shield_overview.review_allow_title_plural', '{n} exceptions of your own are never hidden', { n: row.value.terms }),
        body: t('admin.shield_posture_allow_hint', 'These are deliberately left visible to the AI.'),
    }),
    dlp: (_row, t) => ({
        title: t('shield_overview.review_dlp_title', 'Nobody gets a last check before an outside AI'),
        body: t('shield_overview.review_dlp_body',
            'Optional. With it on, people see what is about to leave and can mark what the detector missed.'),
    }),
};

/** A review item's title and body, or null for a row that has none. */
export function reviewCopy(row: PostureRow, t: TranslateFn): ReviewText | null {
    const fn = REVIEWS[row.id];
    return fn ? fn(row, t) : null;
}
