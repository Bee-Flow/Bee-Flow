import React from 'react';
import BuildingBlocksGroup from '../admin/Studio/AutomationsStudio/BuildingBlocksGroup';
import type { DesignerState } from './useDesignerShell';
import type { AutomationLibrary, AutomationListRow } from './useAutomationLibrary.types';

type ListLibrary = Pick<AutomationLibrary, 'automations' | 'steps' | 'stepsLoading' | 'activeRunIds' | 'onDeleteStep'
    | 'toggleAutomation' | 'duplicateAutomation' | 'exportAutomationJson' | 'copyAutomationId' | 'requestDeleteAutomation'>;

interface DesignerListArgs {
    designer: DesignerState;
    library: ListLibrary;
    automationsAllowed: boolean;
    /** The quick switcher's jump; the flyout and the sidebar both select through it. */
    onPickFromSwitcher: (item: { id?: string }) => void;
}

/**
 * What the sidebar's list and the in-editor flyout show: the filtered automations
 * and building blocks, the shared row-props builder, and the blocks group.
 */
export function useDesignerList({ designer: d, library, automationsAllowed, onPickFromSwitcher }: DesignerListArgs) {
    // ── The Studio layout: sidebar + detail shell ─────────────────────────
    // Filter the active list by the search query (case-insensitive
    // match on title; cheap enough to do every render). Power-user
    // search is also via Cmd/Ctrl+K — this input is the discoverable
    // route for everyone else.
    const q = d.searchQuery.trim().toLowerCase();
    const visibleAutomations = q
        ? library.automations.filter(a => (a.title || '').toLowerCase().includes(q))
        : library.automations;
    // Same filter, for the building blocks (reusable Steps) listed below
    // the automations.
    const visibleSteps = q
        ? library.steps.filter(s => (s.title || '').toLowerCase().includes(q))
        : library.steps;

    // One row-props builder shared by the persistent sidebar's list AND
    // the in-editor flyout (BFSF-404) — same actions menu (Duplicate /
    // Export JSON / Move to folder / Copy ID / Delete / Activate-Pause)
    // wherever the list is shown. `fromFlyout` only adds the "close the
    // flyout" side effect; every callback is the one the plain list uses.
    // onSelect routes through onPickFromSwitcher (not a bare
    // setBuilderAutomationId) so switching automations from the flyout
    // gets the exact same in-flight-stream guard a Cmd/Ctrl+K jump gets,
    // and so it reliably exits an open Reusable-Step builder too — the
    // flyout, unlike the plain sidebar, can be opened while builderStepId
    // is set, and BuilderShell's `stepBuilderOpen` outranks the automation
    // pane unless builderStepId is cleared.
    const makeAutomationRowProps = (a: AutomationListRow, { fromFlyout = false } = {}) => ({
        automation: a,
        kind: 'automation',
        selected: d.builderAutomationId === a.id,
        liveRunning: library.activeRunIds.has(a.id),
        onSelect: () => {
            if (fromFlyout) d.setListFlyoutOpen(false);
            onPickFromSwitcher({ id: a.id });
        },
        onOpenRuns: () => {
            if (fromFlyout) d.setListFlyoutOpen(false);
            d.setBuilderStepId(null);
            d.setBuilderInitialTab('history');
            d.setBuilderAutomationId(a.id);
        },
        onToggleActive: () => library.toggleAutomation(a),
        onDuplicate: () => library.duplicateAutomation(a),
        onExportJson: () => library.exportAutomationJson(a),
        onMoveToFolder: () => d.setMovingAutomation(a),
        onCopyId: () => library.copyAutomationId(a),
        onDelete: () => library.requestDeleteAutomation(a),
    });

    // While a building block is open the flyout leads with the blocks,
    // opened: the Step builder needs the Steps list (BFSF-404 #3).
    const editingBlock = d.builderStepId !== null;
    const blocksGroup = ({ inFlyout = false } = {}) => (
        <BuildingBlocksGroup
            steps={visibleSteps}
            loading={library.stepsLoading}
            filtering={!!q}
            forceOpen={inFlyout && editingBlock}
            leading={inFlyout && editingBlock}
            selectedId={d.builderStepId || null}
            onOpen={(id) => d.openBlock(id)}
            onOpenRuns={(id) => d.openBlock(id, { runs: true })}
            onDelete={library.onDeleteStep}
            onCreate={automationsAllowed ? d.onNewBlock : null}
        />
    );

    return { q, visibleAutomations, visibleSteps, makeAutomationRowProps, editingBlock, blocksGroup };
}
