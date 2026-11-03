import React from 'react';
import { ShieldCheck, Clock } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import StepNodeBase, { NodeChip } from './StepNodeBase';
import { approvalSummary, approvalDeadline } from '../nodeSummaries';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import { APPROVAL_PORT_APPROVED, APPROVAL_PORT_REJECTED } from '../branchEdges';
import type { StepNodeProps } from './nodeProps';

/**
 * The human gate: the run stops here until a person decides.
 *
 * The summary line is the QUESTION rather than the configuration, because that
 * is the only part anyone needs to read to know what this node does — and
 * because an approval whose question is still blank is a real defect (it
 * reaches the approver as "Approval requested" and nothing else), so the muted
 * "no question yet" has to be visible from the canvas.
 *
 * Two source ports, the loop's pattern: "Approved" is the plain way on (an
 * unlabelled edge, branchFromHandle), "On rejected" the branch the run takes
 * when the approver rejects (`label: 'on_rejected'`). Without a rejected
 * branch a rejection ends the run. No error port: approval is in the
 * engine's ON_ERROR_FORBIDDEN_SOURCE_TYPES. Like every node with named
 * ports, it has no "+" (which port would it mean?): drag from a port.
 */
export default function ApprovalNode({ id, data }: StepNodeProps) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter } = data;
    const deadline = approvalDeadline(step);
    // The labels travel as DATA into StepNodeBase, which prints them beside
    // the ports.
    const sourceHandles = [
        { id: APPROVAL_PORT_APPROVED, label: t('automation_editor.approval_port_approved', 'Approved'), tone: 'then' },
        { id: APPROVAL_PORT_REJECTED, label: t('automation_editor.approval_port_rejected', 'On rejected'), tone: 'error' },
    ];

    const badges = (
        <NodeChip title={deadline === 'No deadline'
            ? 'This approval waits as long as it needs to.'
            : `Closed as expired if nobody decides within ${deadline.toLowerCase()}.`}>
            <Clock size={10} />
        </NodeChip>
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
            sourceHandles={sourceHandles}
        />
    );
}
