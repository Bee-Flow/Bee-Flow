import type { MouseEvent, ReactNode } from 'react';
import type { RuntimeContext } from '../buildRuntimeContext';
import type { NodeRunStep, NodeStep, SourceHandleSpec, StepIssue, StepIssues } from './nodeProps';

export type { NodeStep, SourceHandleSpec, StepIssue, StepIssues };

/** A text slot on a card: a string, a React node, or `{ muted }` for "not answered yet". */
export type CardText = ReactNode | { muted: string };

/** The AI step's tool port under the card: a labelled drop zone. */
export interface BottomPort {
    handleId: string;
    label: ReactNode;
    hint?: string | null;
    active?: boolean;
}

export interface StepNodeBaseProps {
    icon: ReactNode;
    typeLabel?: string | null;
    help?: string | null;
    name?: ReactNode;
    sub?: CardText;
    subTitle?: string;
    subDetail?: CardText;
    body?: ReactNode;
    badges?: ReactNode;
    hoverDetail?: unknown;
    runStep?: NodeRunStep | null;
    issues?: StepIssues;
    dim?: boolean;
    nodeId?: string | null;
    onAddAfter?: ((nodeId: string) => void) | null;
    sourceHandles?: SourceHandleSpec[] | null;
    sourceConnectable?: boolean;
    bottomPort?: BottomPort | null;
    family?: string | null;
    stepType?: string | null;
    tone?: string | null;
    onTileClick?: ((e: MouseEvent<HTMLButtonElement>) => void) | null;
    tileLabel?: string | null;
    tileColor?: string | null;
    portsRow?: ReactNode;
}

/** What `NodeRuntimeContext` carries, as the cards read it: the runtime context DiagramPane builds, plus the members it adds later. */
export type NodeRuntime = { [K in keyof RuntimeContext]?: RuntimeContext[K] | null } & {
    onOpenBlock?: ((blockId: string) => void) | null;
    blockSummaries?: Record<string, string>;
    buildFxById?: Map<string, { kind?: string; delayMs?: number; touchedAt?: number }>;
    frontierId?: string | null;
};

/** A stored binding, as the inputs preview reads it. */
export type Binding = { kind: 'literal'; value: unknown } | { kind: 'ref'; path: string } | { kind: 'template' | 'expr'; value?: string };
