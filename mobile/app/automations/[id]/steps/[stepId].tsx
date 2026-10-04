/**
 * One step of an automation, edited: Input | Settings | Output. Pushed from the
 * build screen; `id` is the automation id (or a new automation's draft key),
 * `stepId` the step's id or a held step's address, `section` the settings
 * section a finding points at, `flowlet` the flowlet the step lives in. See
 * features/flow-editor NodeEditorScreen.
 */

import { useLocalSearchParams } from 'expo-router';
import React from 'react';

import { NodeEditorScreen } from '@/features/flow-editor';

export default function StepEditorRoute() {
    const { id, stepId, section, flowlet } = useLocalSearchParams<{ id: string; stepId: string; section?: string; flowlet?: string }>();
    return <NodeEditorScreen automationId={id} stepId={stepId} section={section ?? null} flowlet={flowlet ?? null} />;
}
