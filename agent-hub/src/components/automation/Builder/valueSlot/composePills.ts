import { humanizeKey, sourceProblems } from '@shared/mapping/index.mjs';
import type { MappingSource } from '@shared/mapping/index.mjs';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { classifyPlaceholder, sourceCount } from './composeValue';
import type { SlotPiece } from './composeValue';
import { sourceTint } from './slotDom';
import type { PillSpec } from './slotDom';
import { formulaSummary, pickLabel } from './usePickLabel';

/**
 * What a pill in a ComposeField says, in the current language: the value's
 * name as a chip would say it ("Product of all orderregels"), "≡ 12" for a
 * list, amber "No longer available: …" when the step it came from is gone;
 * a legacy `{{name}}` (an AI step's own input) by its name; anything else
 * as a grey "Formula" with its summary on hover. Never a path.
 */

export interface PillContext {
    /** Step id → display name; a non-empty map also says which steps exist. */
    stepLabelById?: ReadonlyMap<string, string> | null;
    /** Step id → type, for the family colour. */
    stepTypeById?: ReadonlyMap<string, string> | null;
    /** The sample (or last run) a list is counted on. */
    sample?: object | null;
}

/** Is the value's source gone? Only said when the map of steps is known (non-empty). */
export function isStaleSource(from: MappingSource, stepLabelById?: ReadonlyMap<string, string> | null): boolean {
    if (sourceProblems(from).length) return true;
    return from.root === 'steps' && !!stepLabelById?.size && !stepLabelById.has(from.id);
}

function valuePill(t: TranslateFn, piece: Exclude<SlotPiece, string>, from: MappingSource, take: string, ctx: PillContext): PillSpec {
    const { stepLabelById, stepTypeById, sample } = ctx;
    const groupLabel = from.root === 'steps' ? stepLabelById?.get?.(from.id) || null : null;
    const name = pickLabel(t, { from, take }, { groupLabel });
    if (isStaleSource(from, stepLabelById)) {
        return { piece, tone: 'stale', name: t('mapping.slot.stale', 'No longer available: {label}', { label: name }) };
    }
    const list = take === 'all';
    const count = list ? sourceCount(from, sample) : null;
    return {
        piece,
        tone: 'value',
        name,
        list,
        count,
        tint: sourceTint(from.root, 'id' in from ? from.id : undefined, stepTypeById),
        title: name,
        countLabel: typeof count === 'number' ? t('mapping.slot.list_count', '{count} values', { count }) : undefined,
    };
}

/** The pill of one piece that is not text. */
export function pillSpecFor(t: TranslateFn, piece: Exclude<SlotPiece, string>, ctx: PillContext = {}): PillSpec {
    if ('part' in piece) return valuePill(t, piece, piece.part.from, piece.part.take, ctx);
    const kind = classifyPlaceholder(piece.raw);
    if (kind.kind === 'value') return valuePill(t, piece, kind.from, kind.take, ctx);
    if (kind.kind === 'name') {
        return {
            piece,
            tone: 'name',
            name: humanizeKey(kind.name),
            title: t('mapping.compose.name_title', 'Filled in with "{name}" when the step runs', { name: kind.name }),
        };
    }
    const summary = formulaSummary(t, { kind: 'template', value: piece.raw }, ctx.stepLabelById);
    return {
        piece,
        tone: 'formula',
        name: t('mapping.slot.formula', 'Formula'),
        title: summary ? t('mapping.slot.formula_title', 'Formula: {summary}', { summary }) : undefined,
    };
}
