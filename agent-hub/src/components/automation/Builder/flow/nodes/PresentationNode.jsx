import React from 'react';
import { Presentation } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { presentationSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function PresentationNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    return (
        <StepNodeBase
            icon={<Presentation size={14} />}
            typeLabel={nodeTypeLabel('presentation')}
            help={nodeHelp('presentation')}
            name={step.label || nodeDefaultLabel('presentation')}
            sub={presentationSummary(step)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
