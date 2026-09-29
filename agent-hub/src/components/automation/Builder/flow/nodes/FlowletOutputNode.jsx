import React from 'react';
import { LogOut } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';

/**
 * Terminal node inside a Flowlet declaring what the flowlet returns. Its
 * resolved `fields` become the flowlet's output (see execCallLayer/execLayerOutput).
 */
export default function FlowletOutputNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const fields = step.fields && typeof step.fields === 'object' ? Object.keys(step.fields) : [];
    const sub = fields.length === 0
        ? { muted: 'no output fields' }
        : `returns: ${fields.slice(0, 4).join(', ')}${fields.length > 4 ? '…' : ''}`;
    return (
        <StepNodeBase
            icon={<LogOut size={14} />}
            typeLabel={nodeTypeLabel('layer_output')}
            help={nodeHelp('layer_output')}
            name={step.label || 'Return'}
            sub={sub}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
