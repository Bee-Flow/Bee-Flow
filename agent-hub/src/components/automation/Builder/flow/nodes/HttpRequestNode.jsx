import React from 'react';
import { Globe, ShieldAlert } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip, ForEachBadge } from './StepNodeBase';

export default function HttpRequestNode({ id, data }) {
    const { step, runStep, issues, onAddAfter } = data;
    const method = (step.method || 'GET').toUpperCase();
    const url = step.url || '';
    // blockPrivateTargets defaults true — only show the badge when the
    // user has explicitly opted OUT of the SSRF guard, since that's the
    // security-relevant state worth flagging on the canvas.
    const privateTargetsAllowed = step.blockPrivateTargets === false;

    const badges = (
        <>
            <ForEachBadge step={step} />
            {privateTargetsAllowed && (
                <NodeChip tone="warn" title="Private/internal-address blocking is turned OFF for this step — it can reach localhost, private-network, and cloud-metadata targets.">
                    <ShieldAlert size={10} />
                </NodeChip>
            )}
        </>
    );

    return (
        <StepNodeBase
            icon={<Globe size={14} />}
            typeLabel={nodeTypeLabel('http_request')}
            help={nodeHelp('http_request')}
            name={step.label || nodeDefaultLabel('http_request')}
            sub={url ? `${method} ${url}` : { muted: `${method} · no URL set` }}
            subTitle={url ? `${method} ${url}` : undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
