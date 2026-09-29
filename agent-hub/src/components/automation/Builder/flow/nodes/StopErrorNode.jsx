import React from 'react';
import { OctagonX } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';

export default function StopErrorNode({ id, data }) {
    const { step, runStep, issues } = data;
    // NOTHING ever runs after a Stop-and-Error — it halts the run by design.
    // The node therefore offers no "+ add next step" and no draggable source
    // port (B9): the canvas used to invite appending steps here, every one of
    // which was permanently dead with no warning. Legacy outgoing edges (from
    // JSON/AI authoring) still render and stay deletable — the handle remains
    // in the DOM, only new connections are refused.
    //
    // `tone="error"`: an end card painted in --error rather than the theme
    // ink, so "this path ends badly" reads before the text does (design 1a,
    // node 3b).
    return (
        <StepNodeBase
            icon={<OctagonX size={14} />}
            typeLabel={nodeTypeLabel('stop_error')}
            help={nodeHelp('stop_error')}
            name={step.label || nodeDefaultLabel('stop_error')}
            sub={step.message || { muted: 'no message' }}
            subTitle={step.message || undefined}
            tone="error"
            runStep={runStep}
            issues={issues}
            nodeId={id}
            sourceConnectable={false}
        />
    );
}
