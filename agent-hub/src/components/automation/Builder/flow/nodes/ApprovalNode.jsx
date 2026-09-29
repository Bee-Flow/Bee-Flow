import React from 'react';
import { ShieldCheck, Clock } from 'lucide-react';
import PlanLockChip from './PlanLockChip';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { approvalSummary, approvalDeadline } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { usePlanLockReason } from '../usePlanLocks';

/**
 * The human gate: the run stops here until a person decides.
 *
 * The summary line is the QUESTION rather than the configuration, because that
 * is the only part anyone needs to read to know what this node does — and
 * because an approval whose question is still blank is a real defect (it
 * reaches the approver as "Approval requested" and nothing else), so the muted
 * "no question yet" has to be visible from the canvas.
 *
 * No source handles beyond the default one: approval is in the engine's
 * ON_ERROR_FORBIDDEN_SOURCE_TYPES, and a rejection ENDS the run rather than
 * taking a second edge, so there is no branch to draw.
 *
 * Approvals are a plan feature: without it the card carries the lock
 * (PlanLockChip), and the routine cannot go live with this step.
 */
export default function ApprovalNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const deadline = approvalDeadline(step);
    const lock = usePlanLockReason('approval');

    const badges = (
        <>
            <PlanLockChip reason={lock} />
            <NodeChip title={deadline === 'No deadline'
                ? 'This approval waits as long as it needs to.'
                : `Closed as expired if nobody decides within ${deadline.toLowerCase()}.`}>
                <Clock size={10} />
            </NodeChip>
        </>
    );

    return (
        <StepNodeBase
            icon={<ShieldCheck size={14} />}
            typeLabel={nodeTypeLabel('approval')}
            help={nodeHelp('approval')}
            name={step.label || nodeDefaultLabel('approval')}
            sub={approvalSummary(step)}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
