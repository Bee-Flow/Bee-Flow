import { useRef, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { FieldHandle, InsertOpts } from './fieldHandle';
import type { DraggedSource } from './slotDnd';
import { draggedFrom, groupLabelOf, type GroupLike } from './slotModel';
import type { SlotTarget } from './TargetPopover';
import { pickLabel } from './usePickLabel';
import { useSlotRegistry } from './useSlotRegistry';

interface Ask {
    dragged: DraggedSource;
    label: string;
    targets: SlotTarget[];
}

/**
 * The step drawer's half of "click a value in Comes in": which field it
 * goes to.
 *
 * A field hands its handle over on focus (fieldHandle.ts: its methods always
 * run the field's latest state); a click then goes there, with the value's
 * Source and an Alt-click's "insert as it is". The handle is kept per step,
 * so a click never lands in a field of the step before. When no field of
 * this step has had focus yet, `ask` holds the question "Where should this
 * go?" with the step's empty value slots (the registry, required first);
 * choosing one puts the value there and makes it the active field.
 */
export function useActiveField({ stepId, groups, stepLabelById }: {
    stepId: string | null | undefined;
    groups: readonly GroupLike[] | null | undefined;
    stepLabelById?: ReadonlyMap<string, string> | null;
}) {
    const { t } = useTranslation();
    const registry = useSlotRegistry();
    const activeRef = useRef<{ stepId: string | null | undefined; handle: FieldHandle } | null>(null);
    const [active, setActive] = useState<{ stepId: string | null | undefined; label: string | null } | null>(null);
    const [ask, setAsk] = useState<Ask | null>(null);

    const activate = (handle: FieldHandle | null) => {
        activeRef.current = handle ? { stepId, handle } : null;
        setActive(handle ? { stepId, label: handle.label || null } : null);
    };
    const onFocusField = (handle: FieldHandle | null) => { setAsk(null); activate(handle); };

    const onInsert = (path: string, opts: InsertOpts = {}) => {
        const current = activeRef.current;
        if (current && current.stepId === stepId) {
            current.handle.insert(path, opts);
            return;
        }
        const dragged = draggedFrom(path, opts);
        if (!dragged) return;
        const groupLabel = groupLabelOf(dragged.source, groups, stepLabelById);
        setAsk({
            dragged,
            label: pickLabel(t, { from: dragged.source, take: 'one' }, { labelParts: dragged.labelParts, groupLabel }),
            targets: registry.emptySlots().map(h => ({ id: h.id, label: h.label, required: h.required })),
        });
    };

    const onChooseTarget = (id: string) => {
        const pending = ask;
        setAsk(null);
        if (!pending || !registry.deliverTo(id, pending.dragged)) return;
        const label = pending.targets.find(x => x.id === id)?.label || '';
        activate({
            id,
            label,
            insert: (p, o) => { const d = draggedFrom(p, o || {}); if (d) registry.deliverTo(id, d); },
        });
    };

    return {
        registry,
        onFocusField,
        onInsert,
        ask,
        onChooseTarget,
        closeAsk: () => setAsk(null),
        activeLabel: active && active.stepId === stepId ? active.label : null,
    };
}
