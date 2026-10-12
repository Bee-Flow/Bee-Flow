import { Split } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { listPathLabel } from '../../mapping/listPathLabel';
import { describeRuleExpr } from '../displayHelpers';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { useNodeRuntime } from '../NodeRuntimeContext';
import { readRoute } from '../routeModel';
import { ROUTE_STEP_NAME } from '../stepDisplayName';
import StepNodeBase from './StepNodeBase';

/**
 * "Read many ▸ Attachments · 3 outputs + Otherwise" for a Condition with
 * several outputs that works through a list, "3 outputs + Otherwise" for one
 * that decides the whole run. "+ Otherwise" stays off when the catch-all is
 * redirected into one of the outputs (`defaultBranch`).
 *
 * A list Condition with one output whose rest goes to Otherwise (the keep-rest
 * box) reads like a filter card, its rule and then "+ Otherwise":
 * "Read many ▸ Messages · Subject contains “x” + Otherwise".
 */
function outputsWord(step, cases, stepLabelById, t) {
    const n = cases.length;
    if (!n) return null;
    if (step.defaultBranch) {
        return n === 1 ? t('condition_node.canvas.output', '1 output') : t('condition_node.canvas.outputs', '{n} outputs', { n });
    }
    if (readRoute(step).keepRest) {
        const rule = describeRuleExpr(cases[0].expr || '', stepLabelById, t) || t('condition_node.canvas.no_rule', 'no rule yet');
        return t('condition_node.canvas.rule_otherwise', '{rule} + Otherwise', { rule });
    }
    return n === 1
        ? t('condition_node.canvas.output_otherwise', '1 output + Otherwise')
        : t('condition_node.canvas.outputs_otherwise', '{n} outputs + Otherwise', { n });
}

/**
 * List mode: the list on the first line, the outputs (or the keep-rest rule)
 * on the second, so neither truncates the other away. Whole run: one line.
 */
function switchSubtitle(step, cases, stepLabelById, stepTypeById, t) {
    const outputs = outputsWord(step, cases, stepLabelById, t);
    const listMode = typeof step.arrayRef === 'string';
    const list = listMode && step.arrayRef ? listPathLabel(step.arrayRef, stepLabelById, t, { compact: true, stepTypeById }) : '';
    const noList = t('condition_node.canvas.no_list', 'no list yet');
    const rest = outputs || t('condition_node.canvas.no_rule', 'no rule yet');
    const restLine = outputs || { muted: rest };
    if (!listMode) return { sub: restLine, detail: null, title: rest };
    return { sub: list || { muted: noList }, detail: restLine, title: `${list || noList} · ${rest}` };
}

export default function SwitchNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const { t } = useTranslation();
    const { stepTypeById } = useNodeRuntime();
    const cases = (Array.isArray(step.cases) ? step.cases : []).filter((c) => c && typeof c.name === 'string' && c.name);
    const { sub, detail, title } = switchSubtitle(step, cases, stepLabelById, stepTypeById, t);
    // One connectable output port per case, plus a catch-all "default" port
    // (the `case:default` edge fires when no case matches and no defaultBranch
    // redirects). Ports map 1:1 to the edge labels the runtime routes on; the
    // catch-all reads "Otherwise", the word every other surface uses for it.
    const sourceHandles = [
        ...cases.map((c) => ({ id: `case:${c.name}`, label: c.name, tone: 'case' })),
        { id: 'case:default', label: t('condition_node.otherwise.label', 'Otherwise'), tone: 'default' },
    ];
    return (
        <StepNodeBase
            icon={<Split size={14} />}
            typeLabel={nodeTypeLabel('switch')}
            help={nodeHelp('switch')}
            name={step.label || ROUTE_STEP_NAME}
            sub={sub}
            subDetail={detail}
            subTitle={title}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            sourceHandles={sourceHandles}
        />
    );
}
