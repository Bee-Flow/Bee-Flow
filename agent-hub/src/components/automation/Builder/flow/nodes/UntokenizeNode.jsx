import React from 'react';
import { Eye } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { humanizeExpression } from '../displayHelpers';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * "Show real values again".
 *
 * The counterpart to Hide personal data, for the values the runner does not
 * restore on its own — anything that never came back through an AI reply, a
 * tool result or an HTTP response.
 *
 * The node reports what it could NOT resolve, because that is the failure worth
 * seeing: a leftover `[person_5]` reads as ordinary text and travels onward
 * looking deliberate.
 */
export default function UntokenizeNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const source = humanizeExpression(step.sourceRef || '', stepLabelById);
    const out = runStep?.output;
    const outcome = out
        ? (out.unresolved ? `${out.restored} back · ${out.unresolved} unresolved` : `${out.restored || 0} put back`)
        : null;
    const sub = source
        ? [source, outcome].filter(Boolean).join(' · ')
        : { muted: 'nothing to restore yet' };

    const badges = out?.unresolved ? (
        <NodeChip tone="warn" title={`${out.unresolved} placeholder${out.unresolved === 1 ? '' : 's'} this run cannot account for${out.unresolvedTokens?.length ? `: ${out.unresolvedTokens.slice(0, 3).join(', ')}` : ''}`}>
            {out.unresolved} {t('automations.untokenize_node.unresolved', 'unresolved')}
        </NodeChip>
    ) : null;

    return (
        <StepNodeBase
            icon={<Eye size={14} />}
            typeLabel={nodeTypeLabel('untokenize')}
            help={nodeHelp('untokenize')}
            name={step.label || nodeDefaultLabel('untokenize')}
            sub={sub}
            subTitle={step.sourceRef || undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
