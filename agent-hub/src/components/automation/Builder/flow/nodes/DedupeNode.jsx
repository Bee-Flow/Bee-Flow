import React from 'react';
import { Copy } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { dedupeSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function DedupeNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    return (
        <StepNodeBase
            icon={<Copy size={14} />}
            typeLabel={nodeTypeLabel('dedupe')}
            help={nodeHelp('dedupe')}
            name={step.label || nodeDefaultLabel('dedupe')}
            sub={dedupeSummary(step, { stepLabelById })}
            subTitle={step.arrayRef}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
