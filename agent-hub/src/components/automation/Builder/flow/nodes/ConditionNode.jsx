import { Split } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { describeRuleExpr } from '../displayHelpers';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { ROUTE_STEP_NAME } from '../stepDisplayName';
import StepNodeBase from './StepNodeBase';

export default function ConditionNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const { t } = useTranslation();
    // Reads as a sentence ("Subject contains “isv”"), never a raw path or a
    // function name; a rule that is not there yet says so, muted.
    const rule = describeRuleExpr(step.expr || '', stepLabelById, t);
    const sub = rule || { muted: t('condition_node.canvas.no_rule', 'no rule yet') };
    // Two connectable output ports — the true (`then`) and false (`else`)
    // branches the runtime routes on. Port LABELS speak the unified node's
    // language ("did it match?"); the handle ids stay then/else.
    const sourceHandles = [
        { id: 'then', label: t('condition_node.port.match', 'Match'), tone: 'then' },
        { id: 'else', label: t('condition_node.otherwise.label', 'Otherwise'), tone: 'else' },
    ];

    return (
        <StepNodeBase
            icon={<Split size={14} />}
            typeLabel={nodeTypeLabel('condition')}
            help={nodeHelp('condition')}
            name={step.label || ROUTE_STEP_NAME}
            sub={sub}
            subTitle={rule || undefined}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            sourceHandles={sourceHandles}
        />
    );
}
