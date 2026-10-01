/**
 * A legacy data path (`steps.act_4d4307a.output.total`, `item.name`) as the
 * flow editor names it on screen: "gmail search ▸ Total", never an internal
 * step id. The pills in a text field and the plain-text lines around the
 * fields (outline/readableText) read paths through this.
 *
 * This used to sit in a port of the web's value builder model (valueParts),
 * beside the recognisers that turned `upper(path)` or `join(path, ", ")` into
 * an adjustment. Those are gone: a value picked from an earlier step is a
 * pick of the shared mapping core now (features/flow-editor/valueSlot), and
 * a legacy formula the core can lift shows as that pick. What is left is the
 * phone's own naming of a path a text still holds.
 */

import { translate as t } from '@/core/i18n';

import { classifyRef, resolveChipLabel, type StepLabelMap } from './refTokens';
import { humanizeFieldTail } from '../model/displayHelpers';

/** Roots a user can PICK. `secrets` is deliberately absent — never a chip. */
const DATA_ROOTS = new Set(['steps', 'trigger', 'vars', 'loop', 'item', '_index']);
const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z0-9_$]+|\[[^\]]*\])*$/;

/** Is this a data path the picker could have produced? */
export function isDataPath(s: unknown): boolean {
    const text = String(s ?? '').trim();
    if (!text || !PATH_RE.test(text)) return false;
    return DATA_ROOTS.has(text.split(/[.[]/)[0] as string);
}

export interface DataPathLabel {
    name: string;
    suffix: string;
    missing: boolean;
    source: string;
}

/**
 * How a picked path is NAMED on screen — never an internal step id:
 * `steps.act_4d4307a.output.total` reads "gmail search ▸ Total".
 */
export function describeDataPath(path: unknown, stepLabelById: StepLabelMap = null): DataPathLabel {
    const raw = String(path || '').trim();
    if (!raw) return { name: '', suffix: '', missing: false, source: 'steps' };
    const ref = classifyRef(raw);
    if (ref) {
        const { name, suffix, missing } = resolveChipLabel({ ...ref }, stepLabelById);
        // A deleted step reads as "Previous step"; a trigger key that reads nothing keeps its name.
        const shown = missing && ref.source === 'steps' ? t('routines.ndv.prev_step', 'Previous step') : name;
        return { name: shown, suffix: humanizeFieldTail(suffix), missing, source: ref.source };
    }
    const root = raw.split(/[.[]/)[0];
    if (root === 'item') {
        const tail = raw.slice(4).replace(/^\./, '');
        return { name: t('mobile.flow.path.current_row', 'Current row'), suffix: humanizeFieldTail(tail), missing: false, source: 'item' };
    }
    if (raw === '_index') return { name: t('mobile.flow.path.row_number', 'Row number'), suffix: '', missing: false, source: 'item' };
    if (root === 'vars') {
        return { name: t('mobile.flow.path.variable', 'Variable'), suffix: humanizeFieldTail(raw.slice(5)), missing: false, source: 'vars' };
    }
    return { name: raw, suffix: '', missing: false, source: 'steps' };
}
