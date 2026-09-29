import React from 'react';
import { Pencil } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { ForEachBadge } from './StepNodeBase';
import { summariseSetStep } from '../setOperations';
import { SET_STEP_NAME } from '../stepDisplayName';

export default function SetNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    // One line for both modes: "3 fields: name, email, …" (single) or
    // "Each row: +2 fields · number rows · shared ID by Subject" (list).
    const summary = summariseSetStep(step);
    const empty = summary === 'No fields yet' || summary === 'Nothing to do yet';
    return (
        <StepNodeBase
            icon={<Pencil size={14} />}
            typeLabel={nodeTypeLabel('set')}
            help={nodeHelp('set')}
            name={step.label || SET_STEP_NAME}
            sub={empty ? { muted: summary } : summary}
            badges={<ForEachBadge step={step} />}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
