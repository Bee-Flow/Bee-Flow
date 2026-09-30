/**
 * How each step KIND presents itself: a name, an icon, a group and the one
 * line that says what it does. Port of agent-hub AppStudio/flow/
 * stepCatalog.js, pinned by stepCatalog.lockstep.test.ts (which also holds the
 * kinds to the server's STEP_KINDS, so a new step cannot land unlabelled).
 *
 * core is pure, so words are Msg data (key + English) that the UI renders
 * with `say(msg, t)`, and icons are Lucide NAMES from the phone's registry
 * (shared/ui/icons). Two web icons are spelled by their current Lucide name:
 * CheckCircle2 is CircleCheck and FileSignature is FilePenLine (the same
 * glyphs; Lucide renamed them).
 *
 * Group ids are the web's group strings, kept as ids so the two catalogs line
 * up; STEP_GROUP_LABELS says how each one reads.
 */

import { EN_ONLY, say, type Msg, type Translate } from '../msg';
import type { ActionStep } from '../types';
import { STEP_ROWS, type StepGroupId, type StepRow } from './stepRows';

export type { StepGroupId } from './stepRows';

export const STEP_GROUPS: readonly StepGroupId[] = ['On screen', 'Data', 'AI', 'Flow'];

export const STEP_GROUP_LABELS: Readonly<Record<StepGroupId, Msg>> = {
    'On screen': { i18nKey: 'mobile.app_studio.step_group.on_screen', en: 'On screen' },
    Data: { i18nKey: 'mobile.app_studio.step_group.data', en: 'Data' },
    AI: { i18nKey: 'mobile.app_studio.step_group.ai', en: 'AI' },
    Flow: { i18nKey: 'mobile.app_studio.step_group.flow', en: 'Flow' },
};

export interface StepMeta {
    label: Msg;
    group: StepGroupId;
    /** A Lucide icon name from shared/ui/icons (IconName). */
    icon: string;
    blurb: Msg;
    /** Runs on the server (the /step endpoint). */
    server?: boolean;
    /** Holds other steps (condition, switch, loop). */
    container?: boolean;
}

function toMeta([kind, group, icon, label, blurb, flag]: StepRow): [string, StepMeta] {
    const meta: StepMeta = {
        label: { i18nKey: `mobile.app_studio.step.${kind}.label`, en: label },
        group,
        icon,
        blurb: { i18nKey: `mobile.app_studio.step.${kind}.blurb`, en: blurb },
    };
    if (flag) meta[flag] = true;
    return [kind, meta];
}

export const STEP_CATALOG: Readonly<Record<string, StepMeta>> = Object.fromEntries(STEP_ROWS.map(toMeta));

/** Fallback presentation, so an unknown kind is still readable. */
export const UNKNOWN_STEP: StepMeta = {
    label: { i18nKey: 'mobile.app_studio.step.unknown.label', en: 'Step' },
    group: 'Flow',
    icon: 'Bell',
    blurb: { i18nKey: 'mobile.app_studio.step.unknown.blurb', en: '' },
};

export function stepMeta(kind: unknown): StepMeta {
    const known = typeof kind === 'string' ? STEP_CATALOG[kind] : undefined;
    if (known && Object.prototype.hasOwnProperty.call(STEP_CATALOG, kind as string)) return known;
    // An unknown kind reads as its own name, underscores spaced.
    const name = String(kind || 'Step').replace(/_/g, ' ');
    return { ...UNKNOWN_STEP, label: { i18nKey: 'mobile.app_studio.step.unknown.named', en: '{name}', params: { name } } };
}

/** The palette, grouped and in a fixed order. */
export function paletteGroups(): { group: StepGroupId; kinds: (StepMeta & { kind: string })[] }[] {
    return STEP_GROUPS.map((group) => ({
        group,
        kinds: Object.entries(STEP_CATALOG)
            .filter(([, meta]) => meta.group === group)
            .map(([kind, meta]) => ({ kind, ...meta })),
    })).filter((g) => g.kinds.length);
}

/** The default question a fresh "Ask first" step asks. */
export const NEW_STEP_CONFIRM: Msg = { i18nKey: 'mobile.app_studio.step.confirm.default_message', en: 'Are you sure?' };

const stat = (value: unknown) => ({ kind: 'static', value });
const formula = (expr: string) => ({ kind: 'formula', expr });

/** Seeds whose shape does not depend on the caller's options. */
const FIXED_SEEDS: Readonly<Record<string, () => Record<string, unknown>>> = {
    toast: () => ({ message: '', tone: 'info' }),
    open_url: () => ({ url: '', newTab: true }),
    reset_form: () => ({ form: '' }),
    refresh: () => ({}),
    set_variable: () => ({ name: '', value: stat('') }),
    create_record: () => ({ tableId: '', values: {} }),
    update_record: () => ({ tableId: '', recordId: stat(''), values: {} }),
    delete_record: () => ({ tableId: '', recordId: stat('') }),
    run_automation: () => ({ automationId: null }),
    request_approval: () => ({ prompt: stat(''), resultVar: 'approval' }),
    send_email: () => ({ connectorId: '', to: stat(''), subject: stat(''), body: stat('') }),
    ai_extract: () => ({ source: stat(''), schema: [{ name: 'field1', type: 'string', description: '', required: false }] }),
    ai_generate: () => ({ prompt: '', output: 'text', resultVar: 'result' }),
    kb_query: () => ({ query: stat(''), knowledgeBaseIds: [], resultVar: 'results' }),
    generate_file: () => ({ rows: stat([]), fileName: stat('export.csv'), format: 'csv', resultVar: 'file' }),
    fill_document: () => ({ documentId: '', values: {}, resultVar: 'file' }),
    generate_presentation: () => ({ slides: formula('vars.result'), format: 'pptx', houseStyle: true, resultVar: 'file' }),
    redact_pdf: () => ({ source: formula('form.file'), useAi: true, resultVar: 'file' }),
    download_file: () => ({ file: formula('vars.file'), fileName: stat('') }),
    file_intake: () => ({ connectorId: '', threadKey: stat(''), resultVar: 'intake' }),
    dataset_query: () => ({ dataset: stat(''), gene: stat(''), resultVar: 'variants' }),
    ai_browse: () => ({ task: stat(''), resultVar: 'browse' }),
    condition: () => ({ expr: '', then: [], else: [] }),
    switch: () => ({ expr: '', cases: [{ value: '', steps: [] }], default: [] }),
    loop: () => ({ source: stat([]), itemVar: 'item', steps: [] }),
};

export interface NewStepOptions {
    screenId?: string;
    modalId?: string;
    /** The confirm step's question, already translated; English by default. */
    t?: Translate;
}

/**
 * A fresh step of this kind, filled in enough to be valid the moment it
 * lands: a step that arrives failing validation makes the author fix a
 * problem they did not create.
 */
export function newStep(kind: string, { screenId = '', modalId = '', t = EN_ONLY }: NewStepOptions = {}): ActionStep {
    switch (kind) {
        case 'navigate':
            return { kind, screenId };
        case 'open_modal':
        case 'close_modal':
            return { kind, modalId };
        case 'confirm':
            return { kind, message: say(NEW_STEP_CONFIRM, t) };
        default: {
            const seed = Object.prototype.hasOwnProperty.call(FIXED_SEEDS, kind) ? FIXED_SEEDS[kind] : undefined;
            return { kind, ...(seed ? seed() : {}) };
        }
    }
}
