/**
 * The sheets the flow's own parts open over the build screen: the step
 * picker behind a "+", a card's menu, and the last run's result. In a flowlet
 * the picker offers what a flowlet may hold and there is no run to show.
 */

import React from 'react';

import type { FlowCatalog } from '@/features/flow-editor/api';
import { useDraftState, type FlowDraft } from '@/features/flow-editor/hooks';
import type { FlowDefinition } from '@/features/flow-editor/model';
import { stepActions, type AddTarget } from '@/features/flow-editor/model/outline';

import type { Editing } from './BuildBody';
import { cardModel, type CardContext } from '../outline/cardModel';
import { StepActionsMenu } from '../outline/StepActionsMenu';
import { NodePickerSheet } from '../picker/NodePickerSheet';
import { RunSheet, type TestRuns } from '../run';

export interface FlowSheetsProps {
    draft: FlowDraft;
    definition: FlowDefinition;
    card: CardContext;
    catalog: FlowCatalog | null;
    editing: Editing;
    runs: TestRuns | null;
    /** The flowlet on screen, or null for the routine itself. */
    flowlet?: string | null;
    picking: AddTarget | null;
    setPicking: (target: AddTarget | null) => void;
    runSheet: boolean;
    setRunSheet: (open: boolean) => void;
    onOpen: (address: string) => void;
}

export function FlowSheets({ draft, definition, card, catalog, editing, runs, flowlet = null, picking, setPicking, runSheet, setRunSheet, onOpen }: FlowSheetsProps) {
    const locked = useDraftState(draft.store, (s) => s.locked);
    const menuCard = editing.menu ? cardModel(definition, editing.menu, card) : null;
    const run = menuCard && runs ? runs.runByStep.get(menuCard.nodeId) : null;
    return (
        <>
            <NodePickerSheet
                target={picking}
                definition={definition}
                catalog={catalog}
                flowlet={flowlet}
                onClose={() => setPicking(null)}
                onPick={(payload, target) => {
                    setPicking(null);
                    void editing.insert(payload, target);
                }}
            />
            <StepActionsMenu
                title={menuCard?.name ?? null}
                actions={
                    editing.menu
                        ? stepActions(definition, editing.menu, { run, locked, canRun: !!runs, running: !!runs?.running, addTrigger: !flowlet })
                        : []
                }
                onClose={editing.closeMenu}
                onAction={(action) => {
                    if (action === 'addTrigger') {
                        editing.closeMenu();
                        setPicking({ kind: 'root' });
                        return;
                    }
                    if (editing.menu) editing.act(editing.menu, action);
                }}
            />
            {/* A run row's step id is the step's address: the sheet lists top-level steps only. */}
            {runs ? (
                <RunSheet
                    visible={runSheet}
                    runs={runs}
                    definition={definition}
                    onClose={() => setRunSheet(false)}
                    onOpenStep={(stepId) => {
                        setRunSheet(false);
                        onOpen(stepId);
                    }}
                />
            ) : null}
        </>
    );
}
