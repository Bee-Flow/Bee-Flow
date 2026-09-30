/**
 * One flowlet of a routine, built as if it were the routine — the web
 * builder's flowlet scope (useFlowletScope): its own Steps outline and
 * Canvas, the same cards, picker and menus, over the routine's draft store
 * seen through the flowlet (state/scopedStore), so every edit here is an
 * undoable edit of the whole routine, saved by its autosave. The picker
 * offers what a flowlet may hold, and its one "Return" while it has none.
 * A flowlet is run by the routine that calls it, so there is no test run
 * here; its findings are the routine's.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, ErrorState, LoadingState, Screen } from '@/shared/ui';

import type { FlowCatalog } from '../api';
import { BuildBody } from '../components/build/BuildBody';
import { FlowletHeader } from '../components/build/FlowletHeader';
import { FlowSheets } from '../components/build/FlowSheets';
import { RenameFlowletSheet } from '../components/build/RenameFlowletSheet';
import { useCardContext } from '../components/build/useCardContext';
import { useOutlineEditing } from '../components/build/useOutlineEditing';
import { flowletPath, stepEditorPath } from '../components/outline/stepRoute';
import { useCatalog, useDraftState, useFlowDraft, useFlowletDraft, useUnsavedLeave, type FlowDraft } from '../hooks';
import type { FlowDefinition, StepIssues } from '../model';
import type { AddTarget, RunRow } from '../model/outline';

const NO_RUNS: ReadonlyMap<string, RunRow> = new Map();
const NO_FINDINGS: ReadonlyMap<string, StepIssues> = new Map();

function FlowletEditor({ draft, definition, layerKey }: { draft: FlowDraft; definition: FlowDefinition; layerKey: string }) {
    const t = useTranslation();
    const router = useRouter();
    const automationId = useDraftState(draft.store, (s) => s.automationId);
    const catalog: FlowCatalog | null = useCatalog({ freshOnMount: true }).data ?? null;
    const [picking, setPicking] = useState<AddTarget | null>(null);
    const [renaming, setRenaming] = useState(false);
    useUnsavedLeave(draft.key, draft.store);
    const flowId = automationId ?? draft.key;
    const openStep = (address: string, section?: string | null) => router.push(stepEditorPath(flowId, address, section, layerKey));
    const openFlowlet = (key: string) => router.push(flowletPath(flowId, key));
    const editing = useOutlineEditing({
        store: draft.store, catalog, runByStep: NO_RUNS, runRows: [], onOpen: openStep, onTest: () => undefined, onOpenFlowlet: openFlowlet,
    });
    const card = useCardContext(definition, catalog, NO_RUNS, NO_FINDINGS);
    const title = typeof definition.title === 'string' && definition.title ? definition.title : layerKey;
    return (
        <Screen edges={['top', 'bottom']}>
            <FlowletHeader title={title} routine={draft.automation?.title || t('mobile.flow.untitled', 'Untitled routine')} onRename={() => setRenaming(true)} />
            <BuildBody draft={draft} definition={definition} card={card} catalog={catalog} editing={editing} runs={null} onAdd={setPicking} onOpen={openStep} onRunDetails={() => undefined} />
            <FlowSheets
                draft={draft} definition={definition} card={card} catalog={catalog} editing={editing} runs={null} flowlet={layerKey}
                picking={picking} setPicking={setPicking} runSheet={false} setRunSheet={() => undefined} onOpen={openStep}
            />
            {renaming ? (
                <RenameFlowletSheet
                    title={title}
                    onRename={(next) => draft.store.getState().applyOp((d) => ({ ...d, title: next }))}
                    onClose={() => setRenaming(false)}
                />
            ) : null}
        </Screen>
    );
}

export interface FlowletScreenProps {
    /** The routine's id (or an open new routine's draft key). */
    id: string;
    /** The flowlet's key in definition.layers. */
    layerKey: string;
}

export function FlowletScreen({ id, layerKey }: FlowletScreenProps) {
    const t = useTranslation();
    const router = useRouter();
    const routine = useFlowDraft(id);
    const draft = useFlowletDraft(routine, layerKey);
    const ready = useDraftState(routine.store, (s) => s.ready);
    const definition = useDraftState(draft.store, (s) => s.definition);
    if (!ready) {
        return <Screen>{routine.error ? <ErrorState error={routine.error} onRetry={routine.refetch} /> : <LoadingState />}</Screen>;
    }
    if (!definition) {
        return (
            <Screen>
                <EmptyState
                    icon="Layers"
                    title={t('mobile.flow.flowlets.missing', 'This flowlet is not in the routine any more')}
                    message={t('mobile.flow.flowlets.missing_hint', 'It was deleted — by an undo, the AI builder, or on another device.')}
                    actionLabel={t('common.back', 'Back')}
                    onAction={() => router.back()}
                />
            </Screen>
        );
    }
    return <FlowletEditor draft={draft} definition={definition} layerKey={layerKey} />;
}
