import React from 'react';
import { Code2, Lock } from 'lucide-react';
import { nodeHelp, nodeTypeLabel } from '../nodeDefs';
import StepNodeBase, { NodeChip, ForEachBadge } from './StepNodeBase';
import { useTranslation } from '../../../../../hooks/useTranslation';

export default function CodeNode({ id, data }) {
    const { t } = useTranslation();
    const { step, runStep, issues, onAddAfter } = data;
    const code = step.code || '';
    const lineCount = code ? code.split('\n').length : 0;
    const hashShort = (step.codeHash || '').slice(0, 8);
    const sub = lineCount === 0
        ? { muted: 'no code yet' }
        : `${lineCount} line${lineCount === 1 ? '' : 's'}${hashShort ? ` · ${hashShort}` : ''}`;

    const badges = (
        <>
            <ForEachBadge step={step} />
            <NodeChip title={t('automations.code_node.sandboxed_isolated_vm_no_node_bindings', 'Sandboxed isolated-vm — no Node bindings, HTTPS-only fetch.')}>
                <Lock size={10} />
            </NodeChip>
        </>
    );

    return (
        <StepNodeBase
            icon={<Code2 size={14} />}
            typeLabel={nodeTypeLabel('code')}
            help={nodeHelp('code')}
            name={step.label || 'Code step'}
            sub={sub}
            subTitle={hashShort ? `sha256:${hashShort}` : undefined}
            badges={badges}
            runStep={runStep}
            issues={issues}
            nodeId={id}
            onAddAfter={onAddAfter}
        />
    );
}
