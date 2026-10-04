import React, { useState } from 'react';
import AddKindTiles from './AddKindTiles';
import AddPartsDrawer from './AddPartsDrawer';
import ContentToolbar, { type ContentToolbarProps } from './ContentToolbar';
import type { AddPartsPanelProps } from './AddPartsPanel';

/**
 * The ways into "Add to this Solution": the toolbar button (or, on an empty
 * Solution, the inline kind tiles) and the drawer both open. The drawer stays
 * mounted while the first parts arrive, so a failed add is not wiped when the
 * screen switches from empty to filled.
 */

export interface AddEntryProps extends Omit<AddPartsPanelProps, 'variant' | 'onClose' | 'initialKind'> {
    empty: boolean;
    toolbar: Omit<ContentToolbarProps, 'onAdd'>;
}

export default function AddEntry({ empty, toolbar, ...panel }: AddEntryProps) {
    const [open, setOpen] = useState(false);
    const [kind, setKind] = useState<string | null>(null);
    const openOn = (k: string | null) => { setKind(k); setOpen(true); };
    return (
        <>
            {empty
                ? <div data-testid="solution-add-resource"><AddKindTiles bare active={null} onPick={openOn} /></div>
                : <ContentToolbar {...toolbar} onAdd={() => openOn(null)} />}
            <AddPartsDrawer open={open} onClose={() => setOpen(false)} initialKind={kind} {...panel} />
        </>
    );
}
