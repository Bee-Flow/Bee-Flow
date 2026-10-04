import type { ReactNode } from 'react';
import MiniNode from './MiniNode';
import type { MiniNodeProps } from './MiniNode';
import { CONNECTOR, CONNECTOR_ARROW, CONNECTOR_DASHED, RECORD_PILL } from './canvasClasses';

export interface MiniFlowProps {
    nodes: MiniNodeProps[];
    compact?: boolean;
    /** The connector INTO this node index and every later one is dashed (the part that does not exist yet). */
    dashedFrom?: number;
    testId?: string;
}

/**
 * Layout per size, by the flow's OWN width (@container/miniflow), not the
 * viewport: a pattern card in a narrow column stacks while the same card in a
 * wide one runs left to right. Literal strings, so Tailwind sees every class.
 */
const LAYOUT = Object.freeze({
    normal: {
        list: 'flex flex-col items-stretch @[40rem]/miniflow:flex-row @[40rem]/miniflow:items-center',
        item: 'min-w-0 @[40rem]/miniflow:flex-1 @[40rem]/miniflow:basis-0 @[40rem]/miniflow:max-w-[240px]',
        across: 'hidden @[40rem]/miniflow:flex',
        down: 'flex @[40rem]/miniflow:hidden',
    },
    compact: {
        list: 'flex flex-col items-stretch @[28rem]/miniflow:flex-row @[28rem]/miniflow:items-center',
        item: 'min-w-0 @[28rem]/miniflow:flex-1 @[28rem]/miniflow:basis-0 @[28rem]/miniflow:max-w-[200px]',
        across: 'hidden @[28rem]/miniflow:flex',
        down: 'flex @[28rem]/miniflow:hidden',
    },
});

type Layout = (typeof LAYOUT)['normal'];

/**
 * One edge between two cards: a 1.5px line and the ArrowClosed head, across
 * in a row and down in a stack, with the upstream card's record pill on it
 * the way the canvas puts "52 records" on an edge.
 */
function Connector({ layout, dashed, pill, compact }: { layout: Layout; dashed: boolean; pill?: string; compact: boolean }) {
    const line = dashed ? CONNECTOR_DASHED : CONNECTOR;
    return (
        <li aria-hidden={pill ? undefined : true} className="shrink-0 list-none" data-testid="mini-flow-connector" data-dashed={dashed || undefined}>
            <div className={`${layout.across} relative items-center ${compact ? 'w-7' : 'w-10'}`}>
                <span className={`flex-1 border-t-[1.5px] ${line}`} />
                <svg width="7" height="8" viewBox="0 0 7 8" className={`shrink-0 ${CONNECTOR_ARROW}`} aria-hidden="true">
                    <path d="M0 0 L7 4 L0 8 Z" fill="currentColor" />
                </svg>
                {pill && <span className={`absolute left-1/2 -translate-x-1/2 -top-6 ${RECORD_PILL}`}>{pill}</span>}
            </div>
            <div className={`${layout.down} flex-col items-center ${compact ? 'h-5' : 'h-7'} relative`}>
                <span className={`flex-1 border-l-[1.5px] ${line}`} />
                <svg width="8" height="7" viewBox="0 0 8 7" className={`shrink-0 ${CONNECTOR_ARROW}`} aria-hidden="true">
                    <path d="M0 0 L8 0 L4 7 Z" fill="currentColor" />
                </svg>
                {pill && <span className={`absolute left-1/2 ml-3 top-1/2 -translate-y-1/2 ${RECORD_PILL}`}>{pill}</span>}
            </div>
        </li>
    );
}

/**
 * A chain of MiniNodes joined by canvas connectors: horizontal when the flow
 * has room, stacked vertically when it does not. A node's `pill` moves onto
 * its outgoing connector; the last node keeps its own.
 */
export default function MiniFlow({ nodes, compact = false, dashedFrom, testId = 'mini-flow' }: MiniFlowProps) {
    const layout = compact ? LAYOUT.compact : LAYOUT.normal;
    const items: ReactNode[] = [];
    nodes.forEach((node, i) => {
        const last = i === nodes.length - 1;
        if (i > 0) {
            items.push(
                <Connector
                    key={`c${i}`}
                    layout={layout}
                    compact={compact}
                    dashed={dashedFrom != null && i >= dashedFrom}
                    pill={nodes[i - 1].pill}
                />,
            );
        }
        items.push(
            <li key={`n${i}`} className={`${layout.item} list-none`}>
                <MiniNode compact={compact} {...node} pill={last ? node.pill : undefined} />
            </li>,
        );
    });
    return (
        <div className="@container/miniflow w-full" data-testid={testId}>
            <ol className={`${layout.list} m-0 p-0`}>{items}</ol>
        </div>
    );
}
