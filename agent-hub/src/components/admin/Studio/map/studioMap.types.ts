import type { studioAppForKind } from '../studioNav';

type StudioApp = NonNullable<ReturnType<typeof studioAppForKind>>;

export interface Point {
    x: number;
    y: number;
}

/** One box on the map: a building block, or the synthetic approval (`kind` null). */
export interface MapNode extends Point {
    id: string;
    kind: string | null;
    lane: string;
    synthetic?: boolean;
    labelKey?: string;
    labelFallback?: string;
}

/** A building block: always a kind from the registry. */
export interface MapBlock extends MapNode {
    kind: string;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

export interface Sides {
    fromSide: Side;
    toSide: Side;
    fromOff?: number;
    toOff?: number;
}

export interface CurveRoute extends Sides {
    type: 'curve';
    bow?: number;
}

export interface ElbowRoute extends Sides {
    type: 'elbow';
    via?: readonly { x?: number; y?: number }[];
}

export type MapRoute = { type: 'self' } | CurveRoute | ElbowRoute;

/** One edge between two boxes, with the route it follows. */
export interface MapEdge {
    id: string;
    from: string;
    to: string;
    verbs: string[];
    labelKey: string;
    labelFallback: string;
    noteKey?: string;
    noteFallback?: string;
    route: MapRoute;
    labelAt?: Point;
}

/** The path of one edge: the line, the arrow head and the point the label hangs at. */
export interface EdgeGeometry {
    d: string;
    arrow: string;
    mid: Point;
}

/** What the registry knows about a building block. */
export interface BlockMeta {
    app: StudioApp;
    id: string;
    labelKey: string;
    labelFallback: string | null;
    countKey: string;
    urlSegment: string | null;
    category: string | null;
}

/** The state of one box's counter. */
export type CountState = { state: 'unknown' | 'not_counted' | 'pending' } | { state: 'known'; value: number };
