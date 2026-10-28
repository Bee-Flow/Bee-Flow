import { Background, ReactFlow } from '@xyflow/react';
import { Plus } from 'lucide-react';
import React from 'react';
import { type GraphNode } from '../stepGraph';
import type { Connection } from '@xyflow/system';
import type { TranslateParams } from '@/hooks/useTranslation';
import type { StepFlowNodeArgs } from '../ActionFlowEditor.types';

export function FlowBodySection({ rfNodes, rfEdges, nodeTypes, disabled, onConnect, setSelectedId, setAdding, rootEmpty, t }: {
    rfNodes: {
        id: string; type: string; position: { x: number; y: number; }; draggable: boolean; // position is derived; dragging would lie
        selectable: boolean; data: {
            node: GraphNode; selected: boolean; summary: { text: string; missing: boolean; }; onSelect: () => void; onAdd: () => void;
            // The "+" on the node itself — add a step straight after this one,
            // the same gesture the automation builder offers.
            onAddAfter: (() => void) | null; onContextMenu: ((e: React.MouseEvent) => void) | undefined; disabled: boolean;
        };
    }[]; rfEdges: { id: string; source: string; target: string; type: string; }[]; nodeTypes: { appStudioStep: ({ id, data }: StepFlowNodeArgs) => React.JSX.Element; }; disabled: boolean; onConnect: (connection: Connection) => void; setSelectedId: React.Dispatch<React.SetStateAction<string | null>>; setAdding: React.Dispatch<React.SetStateAction<{ prefix: string; after?: string; } | null>>; rootEmpty: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string;
}) {
    return <div className="relative flex-1 min-w-0 rounded-md border border-[var(--border-subtle)] overflow-hidden">
        <ReactFlow
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={nodeTypes}
            onConnect={disabled ? undefined : onConnect}
            // Order is changed with the move controls in the panel, not
            // by dragging: the graph is always a complete chain, so every
            // drag canConnect could receive is one it must refuse.
            onPaneClick={() => { setSelectedId(null); setAdding(null); } }
            fitView
            proOptions={{ hideAttribution: true }}
            nodesDraggable={false}
            nodesConnectable={false}
        >
            <Background gap={16} size={1} color="var(--border-subtle)" />
        </ReactFlow>

        {rootEmpty ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 pointer-events-none">
                <p className="text-xs text-[var(--text-secondary)]">{t('studio_apps_edit.action_flow.nothing_yet', 'Nothing happens yet.')}</p>
                <button
                    type="button"
                    onClick={() => setAdding({ prefix: '' })}
                    disabled={disabled}
                    className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('studio_apps_edit.action_flow.add_first', 'Add the first step')}
                </button>
            </div>
        ) : null}
    </div>;
}
