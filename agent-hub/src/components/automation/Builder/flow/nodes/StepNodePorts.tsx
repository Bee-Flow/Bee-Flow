import React from 'react';
import { Handle, Position } from '@xyflow/react';
import { PORT_PAD, PORT_PITCH } from '../nodeTypeColors';
import type { BottomPort, SourceHandleSpec } from './StepNodeBase.types';

/**
 * A branch port label. The node's family colour by default (a condition's
 * `match`/`otherwise`, a guard's `personal data`/`clean`), `--error` for an
 * on-error port, and a quiet italic for the catch-all `default`.
 */
function branchToneStyle(tone: string, familyColor: string): React.CSSProperties {
    if (tone === 'error') return { background: 'var(--bg-card)', color: 'var(--error)', border: '1.5px solid var(--error)' };
    if (tone === 'default') return { background: 'var(--bg-card)', color: 'var(--text-tertiary)', border: '1px solid var(--border-default)', fontStyle: 'italic' };
    return { background: 'var(--bg-card)', color: familyColor, border: `1.5px solid ${familyColor}` };
}

interface SourcePortsProps {
    branchHandles: SourceHandleSpec[] | null;
    handleClass: string;
    far: boolean;
    familyColor: string;
    sourceConnectable: boolean;
}

/** The card's output side: one port per branch, or the single source handle. */
export function SourcePorts({ branchHandles, handleClass, far, familyColor, sourceConnectable }: SourcePortsProps) {
    if (!branchHandles) {
        return <Handle type="source" position={Position.Right} className={handleClass} style={{ right: -6 }} isConnectable={sourceConnectable} />;
    }
    // One source port per branch, stacked down the right edge, each with an
    // always-visible label pill that overlaps the card's edge (design 1a:
    // `ja · 1 record` / `nee · 0`).
    return (
        <>
            {branchHandles.map((h: SourceHandleSpec, i: number) => {
                // Two ports spread over the card; three or more sit on
                // their own 22px rows, which is what the card grew for.
                const top = branchHandles.length > 2
                    ? PORT_PAD + PORT_PITCH * (i + 0.5)
                    : `${((i + 1) / (branchHandles.length + 1)) * 100}%`;
                return (
                    <React.Fragment key={h.id}>
                        <Handle
                            type="source"
                            id={h.id}
                            position={Position.Right}
                            className={handleClass}
                            style={{ right: -6, top }}
                        />
                        {!far && (
                            <span
                                className="absolute pointer-events-none -translate-y-1/2 max-w-[120px] truncate text-[10px] font-bold leading-3 px-2 py-0.5 rounded-full"
                                style={{ left: 'calc(100% - 24px)', top, ...branchToneStyle(h.tone, familyColor) }}
                                title={h.label}
                            >
                                {h.label}
                            </span>
                        )}
                    </React.Fragment>
                );
            })}
        </>
    );
}

interface ToolPortProps {
    bottomPort: BottomPort;
    nodeId: string;
    far: boolean;
    familyColor: string;
    portsRow: React.ReactNode;
}

/**
 * The AI step's tool port: a labelled drop zone under the card in the family
 * colour. `data-tool-port` is what the ribbon's drop hit-test looks for
 * (flow/stepDrag.js). NOT pointer-events-none: `elementFromPoint` skips such
 * elements, and this IS the target.
 */
export function ToolPort({ bottomPort, nodeId, far, familyColor, portsRow }: ToolPortProps) {
    return (
        <>
            <Handle
                type="source"
                id={bottomPort.handleId}
                position={Position.Bottom}
                isConnectable={false}
                className="!w-2.5 !h-2.5 !rounded-full !border-2 !bg-[var(--bg-primary)] !border-[var(--text-tertiary)] !opacity-70"
                style={{ bottom: -5 }}
            />
            {!far && (() => {
                const toolChip = (
                    <span
                        data-tool-port={nodeId}
                        title={bottomPort.hint || undefined}
                        className={`${portsRow ? 'relative' : 'absolute left-1/2 -translate-x-1/2 z-10'} inline-flex items-center gap-1 px-2 text-[10px] font-semibold whitespace-nowrap leading-4`}
                        style={{
                            bottom: portsRow ? undefined : -17,
                            borderRadius: '0 0 8px 8px',
                            border: `1px solid ${bottomPort.active ? 'var(--text-primary)' : familyColor}`,
                            borderTop: 0,
                            background: bottomPort.active ? 'var(--bg-tertiary)' : 'var(--bg-card)',
                            color: bottomPort.active ? 'var(--text-primary)' : familyColor,
                        }}
                    >
                        {bottomPort.label}
                    </span>
                );
                // With a ports row (an AI step's agent / skill /
                // knowledge), the tool port is the row's last chip.
                return portsRow ? (
                    <div className="absolute left-1/2 -translate-x-1/2 bottom-[-17px] z-10 flex items-start gap-1" data-testid="node-ports-row">
                        {portsRow}
                        {toolChip}
                    </div>
                ) : toolChip;
            })()}
        </>
    );
}
