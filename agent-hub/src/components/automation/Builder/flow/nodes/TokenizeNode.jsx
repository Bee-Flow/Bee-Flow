import React from 'react';
import { VenetianMask } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import PlanLockChip from './PlanLockChip';
import StepNodeBase from './StepNodeBase';
import { humanizeExpression } from '../displayHelpers';
import { usePlanLockReason } from '../usePlanLocks';

/**
 * "Hide personal data" on the canvas.
 *
 * One output, unlike the guard's two: there is nothing to decide, and no
 * restore step to wire — the real values come back on their own wherever the
 * run uses them again.
 *
 * Privacy Shield steps are a plan feature: without it the card carries the
 * lock (PlanLockChip), because a new one cannot go live or be tested. One that
 * is already live keeps running, so the card is not disabled.
 */
export default function TokenizeNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const lock = usePlanLockReason('tokenize');
    const source = humanizeExpression(step.sourceRef || '', stepLabelById);
    const hidden = runStep?.output?.count;
    const outcome = Number.isInteger(hidden)
        ? (hidden === 0 ? 'nothing found' : `${hidden} value${hidden === 1 ? '' : 's'} hidden`)
        : null;
    const sub = source
        ? [source, outcome].filter(Boolean).join(' · ')
        : { muted: 'nothing to hide yet' };

    return (
        <StepNodeBase
            icon={<VenetianMask size={14} />}
            typeLabel={nodeTypeLabel('tokenize')}
            help={nodeHelp('tokenize')}
            name={step.label || nodeDefaultLabel('tokenize')}
            sub={sub}
            subTitle={step.sourceRef || undefined}
            badges={lock ? <PlanLockChip reason={lock} /> : null}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
