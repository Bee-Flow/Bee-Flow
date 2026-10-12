import React from 'react';
import { Globe, ShieldAlert } from 'lucide-react';
import { nodeDefaultLabel, nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip, ForEachBadge } from './StepNodeBase';
import { humanizeTemplate } from '../displayHelpers';
import { inputFromBinding } from '../../../../../utils/bindingHelpers';
import { useTranslation } from '../../../../../hooks/useTranslation';

export default function HttpRequestNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter, stepLabelById } = data;
    // method and url are bindings ({ kind: 'literal' | 'template' | ... }) on
    // a step the builder wrote, plain strings on an older one; read both as
    // the text the step panel shows, never String(object).
    const method = (inputFromBinding(step.method).text || 'GET').toUpperCase();
    const url = inputFromBinding(step.url).text;
    const shownUrl = humanizeTemplate(url, stepLabelById);
    // blockPrivateTargets defaults true — only show the badge when the
    // user has explicitly opted OUT of the SSRF guard, since that's the
    // security-relevant state worth flagging on the canvas.
    const privateTargetsAllowed = step.blockPrivateTargets === false;

    const badges = (
        <>
            <ForEachBadge step={step} />
            {privateTargetsAllowed && (
                <NodeChip tone="warn" title={t('automations.http_request_node.private_internal_address_blocking_is_turned', 'Private/internal-address blocking is turned OFF for this step — it can reach localhost, private-network, and cloud-metadata targets.')}>
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
            sub={url ? `${method} ${shownUrl}` : { muted: `${method} · no URL set` }}
            subTitle={url ? `${method} ${url}` : undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
