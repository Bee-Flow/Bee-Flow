import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { currentItemNoun } from '@shared/mapping/index.mjs';
import type { CurrentItem, PickBinding, PickIntent, Shape, Slot } from '@shared/mapping/index.mjs';
import { useTranslation } from '../../../../hooks/useTranslation';
import { bindingFromInput as bindingFromInputJs } from '../../../../utils/bindingHelpers';
import { useVariablePickerContext as usePickerContextJs } from '../mapping/VariablePickerContext';
import { useFieldHandle, type FieldHandle, type InsertOpts } from './fieldHandle';
import { previewText, resolvePreview } from './PickOptions';
import type { DraggedSource } from './slotDnd';
import {
    acceptPick, columnChoice, countAt, crossesList, draggedFrom, groupLabelOf, isStale, itemShapeAt, makePick, manyForOne, pickFor, shapeAt,
    storedPathOf, storePick, viewOf, slotFor, withItemScope, type Columns, type GroupLike, type SlotSpec, type SlotStorage, type SlotView,
} from './slotModel';
import { pickLabel } from './usePickLabel';
import { useRegisterSlot, useSlotRegistryContext } from './useSlotRegistry';

const bindingFromInput = bindingFromInputJs as (text: unknown, mode: 'fixed' | 'expression') => unknown;
const usePickerContext = usePickerContextJs as () => {
    groups: GroupLike[]; previewSample: object | null; stepLabelById: Map<string, string> | null; stepTypeById: Map<string, string> | null;
    currentItem?: CurrentItem | null;
};

/** How long "Replaced · Undo" stays. */
const TOAST_MS = 8000;

export interface UseValueSlotArgs extends SlotSpec {
    value: unknown;
    onChange: (next: unknown) => void;
    storage: SlotStorage;
    label?: string | null;
    fieldId?: string;
    required?: boolean;
    previewSample?: object | null;
    onFocusField?: ((handle: FieldHandle) => void) | null;
}

/** What the chip of a pick says and shows. */
export interface PickInfo {
    pick: PickBinding;
    lifted: boolean;
    label: string;
    /** The source's shape: the list's, for a pick of the current item. */
    shape: Shape;
    /** A pick of the step's current item (`each`): the options offer "for each item". */
    readsItem: boolean;
    count: number | null;
    preview: string | null;
    stale: boolean;
    warning: boolean;
    columns: Columns | null;
}

/**
 * The state and actions of one ValueSlot: what its value is shown as, and
 * what a click, a drop or a choice does to it. Every way a value arrives
 * goes through `accept`, which asks the core what the field wants of it
 * (slotModel.pickFor) and never destroys typed text (slotModel.acceptPick).
 */
export function useValueSlot({
    value, onChange, storage, label = null, fieldId, required = false, previewSample = null, onFocusField = null,
    slot: slotProp, schema, stepType, field, expectKind, multiLine,
}: UseValueSlotArgs) {
    const { t } = useTranslation();
    const ctx = usePickerContext();
    const registry = useSlotRegistryContext();
    const sample = previewSample ?? ctx.previewSample;
    const groups = ctx.groups;
    const autoId = useId();
    const id = fieldId || autoId;
    const slot: Slot = useMemo(
        () => slotFor({ slot: slotProp, schema, stepType, field, expectKind, multiLine }),
        [slotProp, schema, stepType, field, expectKind, multiLine],
    );
    const view: SlotView = useMemo(() => viewOf(value, storage, sample), [value, storage, sample]);
    const [toast, setToast] = useState<{ previous: unknown } | null>(null);

    useEffect(() => {
        if (!toast) return undefined;
        const timer = setTimeout(() => setToast(null), TOAST_MS);
        return () => clearTimeout(timer);
    }, [toast]);

    /** A value arrives; `hint` is the legacy path it was clicked or dropped as, when known (AcceptContext). */
    const accept = (dragged: DraggedSource, hint: string | null = null) => {
        const { pick } = pickFor(dragged, { storage, slot, sample, names: [field, label] });
        const { value: next, replaced } = acceptPick(value, pick, { storage, slot, sample, hint });
        onChange(next);
        setToast(replaced ? { previous: value } : null);
    };
    const acceptPath = (path: string, opts: InsertOpts = {}) => {
        // A path field keeps the path exactly as the panel wrote it (its [*] included).
        if (storage === 'path' && path.trim()) {
            onChange(path.trim());
            setToast(view.kind !== 'empty' ? { previous: value } : null);
            return;
        }
        const dragged = draggedFrom(path, opts);
        if (dragged) accept(dragged, path);
    };

    const handle = useFieldHandle(id, label || '', { insert: acceptPath, accept: (dragged) => accept(dragged) });
    useRegisterSlot(registry, {
        id,
        label: label || t('mapping.slot.label.value', 'Value'),
        required,
        isEmpty: () => view.kind === 'empty',
        accept: (dragged) => accept(dragged),
    });
    const onFocus = useCallback(() => {
        registry?.focus(id);
        onFocusField?.(handle);
    }, [registry, id, onFocusField, handle]);

    const pickInfo: PickInfo | null = useMemo(() => {
        if (view.kind !== 'pick') return null;
        const { pick } = view;
        const shape = shapeAt(pick.from, sample);
        // A pick of the current item: what ONE item holds decides the count
        // and the amber note, and the preview is the first item's value.
        const currentItem = ctx.currentItem || null;
        const itemShape = itemShapeAt(pick, sample, currentItem);
        const gets = itemShape ?? shape;
        const count = itemShape === null ? countAt(pick.from, sample) : null;
        const groupLabel = groupLabelOf(pick.from, groups, ctx.stepLabelById);
        const resolved = resolvePreview(pick.from, pick, withItemScope(sample, currentItem));
        return {
            pick,
            lifted: view.lifted,
            label: pickLabel(t, pick, { groupLabel, crossesList: crossesList(pick.from, sample), itemNoun: currentItemNoun(pick.from, currentItem) }),
            shape,
            readsItem: itemShape !== null,
            count: gets === 'list' || gets === 'table' ? count : null,
            preview: previewText(resolved),
            stale: isStale(pick.from, groups, sample),
            warning: itemShape === 'unknown' ? false : manyForOne(pick, gets, slot),
            columns: storage === 'path' || itemShape !== null ? null : columnChoice(pick, sample, slot),
        };
    }, [view, sample, groups, ctx.stepLabelById, ctx.currentItem, t, slot, storage]);

    /** A change to the pick on screen (an option, a column), in the slot's spelling. */
    const setPick = (pick: PickBinding) => {
        // The stored path's [*] stay where the sample cannot show the list.
        const next = storePick(pick, storage, sample, storedPathOf(value, storage));
        if (next !== null && next !== undefined) onChange(next);
    };
    const selectIntent = (intent: PickIntent) => {
        if (!pickInfo) return;
        const { join: _join, ...rest } = pickInfo.pick;
        setPick({ ...rest, ...intent } as PickBinding);
    };
    const setColumn = (key: string) => {
        if (!pickInfo?.columns) return;
        const from = { ...pickInfo.columns.table, path: [...pickInfo.columns.table.path, key] } as PickBinding['from'];
        const { pick } = pickFor({ source: from }, { storage, slot, sample });
        setPick(pick);
    };

    /** "Exactly this row" (PickOptions › Advanced): one row of the list, or one cell of the column. */
    const pickRow = (index: number) => {
        if (!pickInfo) return;
        const { columns, pick } = pickInfo;
        const base = columns ? columns.table : pick.from;
        const tail = columns?.column ? [columns.column] : [];
        setPick(makePick({ ...base, path: [...base.path, index, ...tail] } as PickBinding['from'], { take: 'one', as: pick.as }));
    };

    /** Typed text, in the slot's spelling. */
    const setText = (text: string) => {
        if (storage === 'path') onChange(text);
        else onChange(text === '' ? { kind: 'literal', value: '' } : bindingFromInput(text, 'fixed'));
    };
    const clear = () => onChange(storage === 'path' ? '' : { kind: 'literal', value: '' });
    const undo = () => {
        if (!toast) return;
        onChange(toast.previous);
        setToast(null);
    };

    return {
        t, sample, groups, stepLabelById: ctx.stepLabelById, slot, view, pickInfo, handle, onFocus,
        accept, acceptPath, selectIntent, setColumn, pickRow, setText, clear,
        toast: !!toast, undo, dismissToast: () => setToast(null),
    };
}
