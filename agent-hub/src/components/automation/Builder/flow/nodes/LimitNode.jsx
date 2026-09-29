import React from 'react';
import { ChevronsDown } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { limitSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function LimitNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    return (
        <StepNodeBase
            icon={<ChevronsDown size={14} />}
            typeLabel={nodeTypeLabel('limit')}
            help={nodeHelp('limit')}
            name={step.label || nodeDefaultLabel('limit')}
            sub={limitSummary(step, { stepLabelById })}
            subTitle={step.arrayRef}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
