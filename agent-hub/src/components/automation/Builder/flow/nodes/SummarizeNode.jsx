import React from 'react';
import { Sigma } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { summarizeSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function SummarizeNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    return (
        <StepNodeBase
            icon={<Sigma size={14} />}
            typeLabel={nodeTypeLabel('summarize')}
            help={nodeHelp('summarize')}
            name={step.label || nodeDefaultLabel('summarize')}
            sub={summarizeSummary(step, { stepLabelById })}
            subTitle={step.arrayRef}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
