import React from 'react';
import { Split } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';
import { ROUTE_STEP_NAME } from '../stepDisplayName';
import { humanizeExpression, describeRuleExpr } from '../displayHelpers';

export default function FilterNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const friendlySource = humanizeExpression(step.arrayRef || '', stepLabelById);
    const friendlyCond = describeRuleExpr(step.expr || '', stepLabelById);
    // One line: what it works through, then the rule — the card has room for
    // exactly one summary line, and the source is the half a reader needs first.
    const sub = !friendlySource && !friendlyCond
        ? { muted: 'no source, no condition' }
        : [friendlySource || 'no source', friendlyCond || 'no condition'].join(' · ');
    return (
        <StepNodeBase
            icon={<Split size={14} />}
            typeLabel={nodeTypeLabel('filter')}
            help={nodeHelp('filter')}
            name={step.label || ROUTE_STEP_NAME}
            sub={sub}
            subTitle={[step.arrayRef, step.expr].filter(Boolean).join(' · ') || undefined}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
