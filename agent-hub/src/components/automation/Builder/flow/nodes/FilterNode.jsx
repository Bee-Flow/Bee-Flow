import { Split } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { listPathLabel } from '../../mapping/listPathLabel';
import { describeRuleExpr } from '../displayHelpers';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { ROUTE_STEP_NAME } from '../stepDisplayName';
import StepNodeBase from './StepNodeBase';

/**
 * The card's summary: what it works through, then the rule, in the words the
 * editor uses ("Read many ▸ Messages", then "any attachment · File type is PDF").
 * Two lines, list above rule: on one line the run chip and the list left no
 * room and the rule, the half that says what the step does, never showed.
 * A half that is not there yet is muted. `title` is the whole sentence,
 * "<list> · <rule>", on both lines.
 */
function filterSubtitle(step, stepLabelById, stepTypeById, t) {
    const list = step?.arrayRef ? listPathLabel(step.arrayRef, stepLabelById, t, { compact: true, stepTypeById }) : '';
    const rule = describeRuleExpr(step?.expr || '', stepLabelById, t);
    const noList = t('condition_node.canvas.no_list', 'no list yet');
    const noRule = t('condition_node.canvas.no_rule', 'no rule yet');
    return {
        sub: list || { muted: noList },
        detail: rule || { muted: noRule },
        title: `${list || noList} · ${rule || noRule}`,
    };
}

export default function FilterNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const { t } = useTranslation();
    const { stepTypeById } = useNodeRuntime();
    const { sub, detail, title } = filterSubtitle(step, stepLabelById, stepTypeById, t);
    return (
        <StepNodeBase
            icon={<Split size={14} />}
            typeLabel={nodeTypeLabel('filter')}
            help={nodeHelp('filter')}
            name={step.label || ROUTE_STEP_NAME}
            sub={sub}
            subDetail={detail}
            subTitle={title}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
