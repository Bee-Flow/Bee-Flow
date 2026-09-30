/**
 * The step editor screen, pushed over the build screen: the routine's draft
 * (the same store the build screen edits, so both show the same thing and one
 * undo history covers both), then one step in the node editor. Paging to
 * another step swaps the route's `stepId` in place rather than stacking a
 * screen per step; the editor is keyed by it, so each step gets a fresh form.
 *
 * `stepId` is the step's id, or — for a step held in a loop's body or a
 * parallel branch — its address (`loop_1/b_set`). `section` is the settings
 * section a finding sent the author to; it applies to the step it came with,
 * not to the steps paged to after it. `flowlet` names the flowlet the step
 * lives in: the editor then works on that flowlet's graph (useFlowletDraft),
 * and its edits land in the whole routine.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { EmptyState, ErrorState, LoadingState, Screen } from '@/shared/ui';

import { NodeEditor } from '../components/nodeEditor';
import { useCatalogOnReturn, useDraftState, useFlowDraft, useFlowletDraft, useUnsavedLeave } from '../hooks';
import { findNode } from '../model/outline';

export { stepEditorHref } from '../components/outline/stepRoute';

export interface NodeEditorScreenProps {
    /** The routine id, or a new routine's draft key. */
    automationId: string;
    stepId: string;
    section?: string | null;
    /** The flowlet the step lives in (definition.layers[flowlet]); null in the routine itself. */
    flowlet?: string | null;
}

export function NodeEditorScreen({ automationId, stepId, section = null, flowlet = null }: NodeEditorScreenProps) {
    const t = useTranslation();
    const router = useRouter();
    const routine = useFlowDraft(automationId);
    const flow = useFlowletDraft(routine, flowlet);
    useUnsavedLeave(flow.key, flow.store);
    useCatalogOnReturn();
    const ready = useDraftState(flow.store, (s) => s.ready);
    const exists = useDraftState(flow.store, (s) => !!findNode(s.definition, stepId));
    const [opened] = useState({ stepId, section });

    if (!ready) {
        return <Screen>{flow.error ? <ErrorState error={flow.error} onRetry={flow.refetch} /> : <LoadingState />}</Screen>;
    }
    if (!exists) {
        return (
            <Screen>
                <EmptyState
                    icon="CircleQuestionMark"
                    title={t('mobile.flow.ndv.missing', 'This step is not in the routine any more')}
                    message={t('mobile.flow.ndv.missing_hint', 'It was removed — by an undo, the AI builder, or on another device.')}
                    actionLabel={t('common.back', 'Back')}
                    onAction={() => router.back()}
                />
            </Screen>
        );
    }
    return (
        <NodeEditor
            key={stepId}
            flow={flow}
            stepId={stepId}
            section={opened.stepId === stepId ? opened.section : null}
            flowlet={flowlet}
            onPage={(next) => router.setParams({ stepId: next })}
        />
    );
}
