import React from 'react';
import { RectangleHorizontal } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { slideSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function SlideNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    return (
        <StepNodeBase
            icon={<RectangleHorizontal size={14} />}
            typeLabel={nodeTypeLabel('slide')}
            help={nodeHelp('slide')}
            name={step.label || nodeDefaultLabel('slide')}
            sub={slideSummary(step)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
