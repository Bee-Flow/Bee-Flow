import React from 'react';
import { Bell } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip, ForEachBadge } from './StepNodeBase';
import { humanizeTemplate } from '../displayHelpers';
import { CHANNEL_LABELS } from '../../notificationDefaults';

export default function NotificationNode({ id, data }) {
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    // The chip used to read the raw key — a node whose only badge said
    // "notification" told the author nothing about where the message lands
    // (BFSF-350).
    const channels = (Array.isArray(step.channels) && step.channels.length ? step.channels : ['notification'])
        .map(c => CHANNEL_LABELS[c] || c);
    const title = step.title || '';
    const bodyText = step.body || '';
    const friendlyTitle = humanizeTemplate(title, stepLabelById);
    const friendlyBody = humanizeTemplate(bodyText, stepLabelById);

    const badges = (
        <>
            <ForEachBadge step={step} />
            {channels.slice(0, 2).map(c => <NodeChip key={c} title={channels.join(', ')}>{c}</NodeChip>)}
        </>
    );

    return (
        <StepNodeBase
            icon={<Bell size={14} />}
            typeLabel={nodeTypeLabel('notification')}
            help={nodeHelp('notification')}
            // The step's own name first: the title is a TEMPLATE for the
            // message ("Order {{…}}"), which made the card read like the
            // message instead of saying what the step is. A label that is
            // still the type's default gives way to the title.
            name={(step.label && step.label !== nodeDefaultLabel('notification') ? step.label : null)
                || friendlyTitle || step.label || nodeDefaultLabel('notification')}
            sub={friendlyBody || { muted: 'no message yet' }}
            subTitle={bodyText || undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
