import React from 'react';
import { Hourglass } from 'lucide-react';
import StepNodeBase from './StepNodeBase';
import { waitSummary } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';

export default function WaitNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    // Used to print the stored value raw — "7200s" for a Wait the user set to
    // "2 hours" in an editor that has offered hours all along. Both sides now
    // read flow/waitDuration.js, so they cannot disagree about the unit.
    return (
        <StepNodeBase
            icon={<Hourglass size={14} />}
            typeLabel={nodeTypeLabel('wait')}
            help={nodeHelp('wait')}
            name={step.label || nodeDefaultLabel('wait')}
            sub={waitSummary(step)}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
