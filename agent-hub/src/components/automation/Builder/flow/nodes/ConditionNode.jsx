import React from 'react';
import { Split } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase from './StepNodeBase';
import { ROUTE_STEP_NAME } from '../stepDisplayName';
import { describeRuleExpr } from '../displayHelpers';

export default function ConditionNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const expr = step.expr || '';
    // Reads as a sentence ("Subject contains “isv”"), never a raw path.
    const friendlyExpr = describeRuleExpr(expr, stepLabelById);
    // Two connectable output ports — the true (`then`) and false (`else`)
    // branches the runtime routes on. Port LABELS speak the unified node's
    // language ("did it match?"); the handle ids stay then/else.
    const sourceHandles = [
        { id: 'then', label: 'match', tone: 'then' },
        { id: 'else', label: 'otherwise', tone: 'else' },
    ];

    return (
        <StepNodeBase
            icon={<Split size={14} />}
            typeLabel={nodeTypeLabel('condition')}
            help={nodeHelp('condition')}
            name={step.label || ROUTE_STEP_NAME}
            sub={friendlyExpr || { muted: 'no expression' }}
            subTitle={expr || undefined}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            sourceHandles={sourceHandles}
        />
    );
}
