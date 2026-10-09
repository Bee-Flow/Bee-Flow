import React from 'react';
import { Braces, Sparkles } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { ForEachBadge, NodeChip } from './StepNodeBase';
import { useTranslation } from '../../../../../hooks/useTranslation';

export default function ParseJsonNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter } = data;
    const fields = Array.isArray(step.fields) ? step.fields.filter(f => f && f.name).map(f => f.name) : [];
    const sub = fields.length === 0
        ? { muted: 'no fields' }
        : `${fields.length} field${fields.length === 1 ? '' : 's'}: ${fields.slice(0, 4).join(', ')}${fields.length > 4 ? '…' : ''}`;
    const badges = (
        <>
            {step.mode === 'ai' && (
                <NodeChip tone="accent" title={t('automations.parse_json_node.extracts_with_ai_on_every_run', 'Extracts with AI on every run')}>
                    <Sparkles size={10} /> AI
                </NodeChip>
            )}
            <ForEachBadge step={step} />
        </>
    );
    return (
        <StepNodeBase
            icon={<Braces size={14} />}
            typeLabel={nodeTypeLabel('parse_json')}
            help={nodeHelp('parse_json')}
            name={step.label || 'Parse JSON'}
            sub={sub}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
