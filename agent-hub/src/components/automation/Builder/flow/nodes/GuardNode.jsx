import React from 'react';
import { ShieldAlert } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import PlanLockChip from './PlanLockChip';
import StepNodeBase from './StepNodeBase';
import { humanizeExpression } from '../displayHelpers';
import { usePlanLockReason } from '../usePlanLocks';

/**
 * The guard step on the canvas — "does this contain personal data?".
 *
 * Two output ports, the same then/else the runtime routes on, but named for
 * what this step actually decided. A guard whose ports read "match" /
 * "otherwise" tells a reader nothing about which line carries the alert.
 *
 * A plan feature, like Hide personal data: see TokenizeNode for the lock.
 */
export default function GuardNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    const lock = usePlanLockReason('guard');
    const source = humanizeExpression(step.sourceRef || '', stepLabelById);
    const onFound = step.onFound || {};
    const consequences = [onFound.stop ? 'stops the run' : null, onFound.mask ? 'masks a copy' : null].filter(Boolean);
    const sub = source
        ? [source, ...consequences].join(' · ')
        : { muted: 'nothing to scan yet' };

    const sourceHandles = [
        { id: 'then', label: 'personal data', tone: 'else' },
        { id: 'else', label: 'clean', tone: 'then' },
    ];

    return (
        <StepNodeBase
            icon={<ShieldAlert size={14} />}
            typeLabel={nodeTypeLabel('guard')}
            help={nodeHelp('guard')}
            name={step.label || nodeDefaultLabel('guard')}
            sub={sub}
            subTitle={step.sourceRef || undefined}
            badges={lock ? <PlanLockChip reason={lock} /> : null}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
            sourceHandles={sourceHandles}
        />
    );
}
