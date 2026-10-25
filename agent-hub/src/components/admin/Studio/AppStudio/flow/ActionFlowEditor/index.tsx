import { ReactFlowProvider } from '@xyflow/react';
import React from 'react';
import '@xyflow/react/dist/style.css';

import type { AppDefinition, AppNode, FormFieldRef } from '../../inspector/appDefinition';
import type { FlowBodyProps, StepFlowNodeData } from '../ActionFlowEditor.types';
import { FlowBody } from './FlowBody';

/**
 * An action, as a picture you can build.
 *
 * A multi-step action could only ever be written by the AI builder — the
 * inspector edits four of the ten action kinds and none of the eighteen step
 * kinds. So "when this button is clicked, check something, then write a row,
 * then go to the next screen" was describable in a chat message and unreachable
 * any other way.
 *
 * ── WHY THIS IS NOT THE AUTOMATIONS CANVAS ──────────────────────────
 * That one draws a DAG whose runner gates fan-in. An App Studio action is a
 * strict tree, and it has to stay one: `stepIndex` is never stored, so the
 * browser and the server each derive it by walking the saved tree in the same
 * pre-order. A merge or a fan-out here would break that agreement silently, on
 * the server, at run time. stepGraph.canConnect is what refuses those, and
 * stepGraph.test.js pins the pre-order walk itself.
 *
 * What IS shared is the vocabulary: branches read `then` / `else` /
 * `case:<name>`, the same words the automation builder uses.
 *
 * `action` is a definition.actions entry; `onChange` emits the next one. Ids on
 * steps are assigned here and stripped on the way out — the schema addresses a
 * step by position, not by name.
 */

export default function ActionFlowEditor(props: React.JSX.IntrinsicAttributes&FlowBodyProps) {
    // React Flow needs its provider; keeping it here means callers mount one
    // component, not two.
    return (
        <ReactFlowProvider>
            <FlowBody {...props} />
        </ReactFlowProvider>
    );
}

