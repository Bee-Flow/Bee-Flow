/**
 * Which step, trigger or loop item a legacy reference reads, and the name its
 * pill wears (the step's NAME, never `steps.ai_87e358`). Display-only. Once a
 * port of agent-hub `Builder/mapping/refTokens.js`; the tokenizer half went
 * when the phone stopped reading formulas into parts, and the rest is the
 * phone's own (dataPath.test.ts).
 */

import { translate as t } from '@/core/i18n';
import { TRIGGER_RUN_KEYS } from '@/shared/mapping';

const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';
const FIELD = '[A-Za-z0-9_$]+(?:\\.[A-Za-z0-9_$]+|\\[[^\\]]*\\])*';

const STEPS_ANCHOR = new RegExp(`^steps\\.(${IDENT})\\.output(?:\\.(${FIELD}))?$`);
const TRIGGER_ANCHOR = new RegExp(`^trigger(\\.output)?(?:\\.(${FIELD}))?$`);
const RUN_KEYS = new Set<string>(TRIGGER_RUN_KEYS);
const LOOP_ANCHOR = new RegExp(`^loop\\.(${IDENT})(?:\\.(${FIELD}))?$`);

export interface RefInfo {
    source: 'steps' | 'trigger' | 'loop';
    stepId?: string;
    itemVar?: string;
    fieldPath: string;
    /** `trigger.<key>` that reads neither the payload nor the trigger's metadata. */
    noOutput?: true;
}

/** A bare, trimmed path as a ref — or null. */
export function classifyRef(path: unknown): RefInfo | null {
    if (typeof path !== 'string') return null;
    const text = path.trim();
    let m = STEPS_ANCHOR.exec(text);
    if (m) return { source: 'steps', stepId: m[1] as string, fieldPath: m[2] || '' };
    m = LOOP_ANCHOR.exec(text);
    if (m) return { source: 'loop', itemVar: m[1] as string, fieldPath: m[2] || '' };
    m = TRIGGER_ANCHOR.exec(text);
    if (m) {
        const ref: RefInfo = { source: 'trigger', fieldPath: m[2] || '' };
        // `trigger.subject` (no `.output`) reads nothing unless it names run metadata.
        if (!m[1] && m[2] && !RUN_KEYS.has(/^[A-Za-z0-9_$]+/.exec(m[2])?.[0] ?? '')) ref.noOutput = true;
        return ref;
    }
    return null;
}

export interface ChipLabel {
    name: string;
    suffix: string;
    missing: boolean;
}

/** Id → step label, as the inspector keeps it. */
export type StepLabelMap = Pick<Map<string, string>, 'has' | 'get'> | null | undefined;

/**
 * The display label for a ref token. `missing` is true only for a steps ref
 * whose id is not in the definition any more (a deleted step).
 */
function loopChipName(itemVar: string | undefined): string {
    return itemVar
        ? t('mobile.flow.ref.loop_item_named', 'Loop item · {name}', { name: itemVar })
        : t('mobile.flow.ref.loop_item', 'Loop item');
}

function stepChip(id: string, fieldPath: string | undefined, labels: StepLabelMap): ChipLabel {
    return { name: labels?.get?.(id) || id, suffix: fieldPath || '', missing: !labels?.has?.(id) };
}

export function resolveChipLabel(
    token: (Partial<RefInfo> & { path?: string }) | null | undefined,
    stepLabelById: StepLabelMap = null,
): ChipLabel {
    if (!token) return { name: '', suffix: '', missing: false };
    const suffix = token.fieldPath || '';
    if (token.source === 'steps') return stepChip(token.stepId as string, suffix, stepLabelById);
    if (token.source === 'trigger') return { name: t('routines.node.trigger.defaultLabel', 'Trigger'), suffix, missing: token.noOutput === true };
    if (token.source === 'loop') return { name: loopChipName(token.itemVar), suffix, missing: false };
    return { name: token.path || '', suffix: '', missing: false };
}
