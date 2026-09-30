/**
 * The New playbook form, as pure functions: what the composed recipe asks
 * for (the web's recipeForm.js), whether the form may start, the create body
 * it sends (NewPlaybookDialog.start), and which model tiers it offers.
 *
 * A playbook is described in the person's own words and the AI writes the
 * phases (the web's only door since 2026-09-16: the built-in recipe list is
 * empty). The description travels verbatim as `options.ask`, because the
 * designer phase reads the original, not the AI's reading of it.
 */

import type { Recipe, RecipeInput } from './types';

export const MAX_DESCRIPTION = 2000;
export const MAX_TITLE = 120;
const MAX_FOLDER = 300;

export type TableMode = 'new' | 'existing';

export interface NewPlaybookForm {
    title: string;
    tableMode: TableMode;
    datatableId: string;
    inputs: Record<string, string>;
    tier: string;
    approverGroupId: string;
}

export function initialInputValues(recipe: Pick<Recipe, 'inputs'> | null): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of recipe?.inputs ?? []) out[i.key] = i.default ?? '';
    return out;
}

export function initialForm(recipe: Recipe | null): NewPlaybookForm {
    return {
        title: recipe?.title ?? '',
        tableMode: 'new',
        datatableId: '',
        inputs: initialInputValues(recipe),
        tier: 'fast',
        approverGroupId: '',
    };
}

/** A folder input must be an absolute Nextcloud path — the server refuses anything else. */
export function folderProblem(input: RecipeInput, value: string | undefined): boolean {
    if (input.kind !== 'folder') return false;
    const v = String(value ?? '').trim();
    return !(v.startsWith('/') && v.length <= MAX_FOLDER);
}

export function hasTable(recipe: Pick<Recipe, 'fields'> | null): boolean {
    return !!recipe && Array.isArray(recipe.fields);
}

export function canStart(recipe: Recipe | null, form: NewPlaybookForm): boolean {
    if (!recipe || !form.title.trim()) return false;
    if (recipe.inputs.some((i) => folderProblem(i, form.inputs[i.key]))) return false;
    return !hasTable(recipe) || form.tableMode === 'new' || !!form.datatableId;
}

/** POST /api/playbooks — the web's body for a described playbook, field for field. */
export function createBody(recipe: Recipe, form: NewPlaybookForm, ctx: { description: string; locale: string }): Record<string, unknown> {
    const inputs: Record<string, string> = {};
    for (const i of recipe.inputs) inputs[i.key] = String(form.inputs[i.key] ?? '').trim();
    const table = hasTable(recipe);
    const ask = ctx.description.trim();
    return {
        recipe: recipe.raw,
        title: form.title.trim(),
        options: {
            tableMode: table ? form.tableMode : undefined,
            datatableId: table && form.tableMode === 'existing' ? form.datatableId : undefined,
            inputs,
            folderPath: inputs.folderPath,
            tier: form.tier,
            locale: ctx.locale,
            approverGroupId: form.approverGroupId || undefined,
            ask: ask || undefined,
        },
    };
}

/**
 * The depth tiers the dialog can offer, in the web's order: tierMeta's
 * STANDARD_TIER_ORDER narrowed to its DEPTH_TIER_KEYS (`deep_thinking` is a
 * depth key but not in that order, so the web never lists it — `pro` is the
 * same tier).
 */
export const DEPTH_TIER_KEYS = ['auto', 'fast', 'thinking', 'pro'] as const;

/** Until the server answers with something usable, the two tiers a playbook has always had. */
export const FALLBACK_TIERS: readonly string[] = ['fast', 'auto'];

/**
 * The tiers this person may pick: the depth keys the server configured for
 * them (a model behind it, or `auto`), in the web's order. Auto alone means
 * nothing is configured yet — the fallback, not a one-option picker.
 */
export function depthTiers(tiers: Readonly<Record<string, { modelId?: string }>> | null | undefined): readonly string[] {
    // Auto is always there (the web's configuredTierKeys); the rest need a model.
    const keys = DEPTH_TIER_KEYS.filter((k) => k === 'auto' || !!tiers?.[k]?.modelId);
    return keys.some((k) => k !== 'auto') ? keys : FALLBACK_TIERS;
}

/** The keys that must be translated before the form counts as being in another language. */
export const LANGUAGE_ANCHORS = ['playbooks.new.title', 'playbooks.new.describe_label', 'playbooks.phase.table'] as const;

/**
 * The language the playbook is BUILT in — its columns, briefs and the app's
 * labels. It is the language on screen, measured against the words this form
 * renders (the web's readingLocale): a catalogue that does not cover the
 * playbook screens shows them in English, so the demo is built in English too.
 */
export function buildLocale(locale: string, strings: Readonly<Record<string, string>> | null | undefined): string {
    if (!locale || locale === 'en' || !strings || Object.keys(strings).length === 0) return 'en';
    return LANGUAGE_ANCHORS.every((k) => typeof strings[k] === 'string' && strings[k] !== '') ? locale : 'en';
}

/** The i18n key of a tier's name: `pro` shares deep thinking's word. */
export function tierKey(tier: string): string {
    return tier === 'pro' ? 'tier.deep_thinking' : `tier.${tier}`;
}

const TIER_EN: Readonly<Record<string, string>> = { auto: 'Auto', fast: 'Fast', thinking: 'Think', pro: 'Deep Thinking', deep_thinking: 'Deep Thinking' };

export function tierEnglish(tier: string): string {
    return TIER_EN[tier] ?? tier;
}
