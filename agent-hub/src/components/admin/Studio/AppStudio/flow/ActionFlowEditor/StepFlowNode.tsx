import { Handle, Position } from '@xyflow/react';
import { AlertTriangle, CornerDownRight, Plus, Server } from 'lucide-react';
import { NODE_W } from '../layout';
import { stepMeta } from '../stepCatalog';
import { scopesOf } from '../stepGraph';
import useTranslation from '../../../../../../hooks/useTranslation';
import StepNodeBase from '../../../../../automation/Builder/flow/nodes/StepNodeBase';
import type { StepFlowNodeArgs } from '../ActionFlowEditor.types';

export function StepFlowNode({ id, data }: StepFlowNodeArgs) {
    const { t } = useTranslation();
    const { node, selected, summary, onSelect, onAdd, onAddAfter, onContextMenu, disabled } = data;

    if (node.isEntry) {
        return (
            <div style={{ width: NODE_W }}>
                <Handle type="source" position={Position.Bottom} style={{ background: 'var(--editor-accent)' }} />
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)]">
                    <CornerDownRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span className="font-medium">{node.scopeLabel}</span>
                    <button
                        type="button"
                        onClick={onAdd}
                        disabled={disabled}
                        aria-label={t('studio_apps_edit.action_flow.add_step_to', 'Add a step to {scope}', { scope: node.scopeLabel })}
                        className="ml-auto px-1.5 py-0.5 rounded border border-dashed border-[var(--border-default)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                    >
                        <Plus className="w-3 h-3" aria-hidden="true" />
                    </button>
                </div>
            </div>
        );
    }

    const meta = stepMeta(node.kind, t);
    const Icon = meta.icon;
    const branches = scopesOf(node.step, t);

    const body = (
        <div>
            <div className="font-semibold truncate">{meta.label}</div>
            <div
                className={`mt-0.5 flex items-center gap-1 text-[10px] truncate ${
                    summary?.missing ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'
                }`}
                data-step-missing-ref={summary?.missing ? 'true' : undefined}
            >
                {summary?.missing ? (
                    <AlertTriangle className="w-3 h-3 shrink-0" aria-label={t('studio_apps_edit.action_flow.missing', 'This no longer exists')} />
                ) : null}
                <span className="truncate">{summary?.text}</span>
            </div>
        </div>
    );

    return (
        <div
            style={{ width: NODE_W }}
            onClick={onSelect}
            onContextMenu={onContextMenu}
            data-step-node={node.id}
            data-selected={selected || undefined}
            className={selected ? 'rounded-lg ring-2 ring-[var(--editor-accent)]' : undefined}
        >
            <StepNodeBase
                icon={<Icon size={14} />}
                typeLabel={meta.label}
                help={meta.blurb}
                body={body}
                badges={meta.server ? (
                    <Server className="w-3 h-3 text-[var(--text-tertiary)]" aria-label={t('studio_apps_edit.action_flow.runs_on_server', 'Runs on the server')} />
                ) : null}
                // A reference pointing at something deleted is a real error, so
                // it lights the same validation badge a bad automation step does.
                issues={summary?.missing ? { errors: [{ path: '', message: t('studio_apps_edit.action_flow.missing', 'This no longer exists') }], warnings: [] } : undefined}
                nodeId={id}
                onAddAfter={disabled ? null : onAddAfter}
                // condition/switch/loop get one output port per branch, the way
                // the automation builder draws its own branching steps.
                sourceHandles={branches.length
                    ? branches.map((b) => ({ id: b.key, label: b.label, tone: 'neutral' }))
                    : null}
                sourceConnectable={false}
            />
        </div>
    );
}
