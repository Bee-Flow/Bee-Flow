import React from 'react';
import { Layers } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { aggregateSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function AggregateNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    return (
        <StepNodeBase
            icon={<Layers size={14} />}
            typeLabel={nodeTypeLabel('aggregate')}
            help={nodeHelp('aggregate')}
            name={step.label || nodeDefaultLabel('aggregate')}
            sub={aggregateSummary(step, { stepLabelById })}
            subTitle={step.arrayRef}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
