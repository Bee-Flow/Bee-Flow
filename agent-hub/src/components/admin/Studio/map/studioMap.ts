import { countFor, type StudioCounts } from '../../../../hooks/useStudioCounts';
import { cardChrome } from '../../../automation/Builder/flow/nodeTypeColors';
import { cardRadius as kindCardRadius, kindColorVar } from '../../../shared/kindColors';
import { STUDIO_CATEGORIES, type Translate } from '../studioGates';
import { studioAppForKind } from '../studioNav';
import type { BlockMeta, CountState, CurveRoute, EdgeGeometry, ElbowRoute, MapBlock, MapEdge, MapNode, Point, Side } from './studioMap.types';

/**
 * The map on the Studio Start screen: the twelve building blocks and the twelve ways
 * they hang together. This file is the MODEL — the hand-chosen coordinates, the edges
 * and the geometry. StudioMap.jsx draws.
 *
 * ── THIS IS DELIBERATELY NOT A LIVE ORG-WIDE GRAPH ─────────────────────────
 *
 * Not out of convenience, and not because the data is missing: the argument is
 * written out in components/admin/Studio/Solutions/ProjectFlowTab.jsx (lines 1-18),
 * and it stands. What a builder wants to know from such a plate is “what depends on
 * what, and what is broken”, and a hand-drawn node drawing answers that at this scale
 * worse than prose — while it costs a layout engine and many ways to look wrong on a
 * narrow screen. That is why the LIVE graph is built per solution (server/projects/
 * graph.js + Track O), where the nodes are counted, the owners known, and a broken
 * edge gets a sentence.
 *
 * What stands here is therefore a LEGEND, not an inventory. It draws the KINDS and the
 * KIND EDGES that the product knows — never someone's own objects. The numbers on the
 * tiles come separately from GET /api/studio/counts.
 *
 * Whoever later wants to promote it to a live org-wide graph: first read
 * ProjectFlowTab.jsx:1-18 and graph.js:1-64. Both explain why an org-wide node drawing
 * precisely does NOT answer the question.
 *
 * ── Hand-drawn means: this goes out of date ────────────────────────────────
 *
 * The coordinates below were chosen by hand. If an eleventh building block arrives, it
 * has no place on this map and the plate would silently be incomplete. There is one
 * defence against that, and it is in studioMap.test.js: the kinds in MAP_BLOCKS are
 * compared with KIND_KEYS from shared/kindColors.js (the register), and the test goes
 * red as soon as they diverge — in both directions. Redraw the map, then.
 */

/* ── Meetkunde ────────────────────────────────────────────────────────────── */

export const TILE_W = 160;
export const TILE_H = 46;
export const MAP_W = 700;
export const MAP_H = 534;

/**
 * The three lanes are the categories of the register (STUDIO_CATEGORIES), in the same
 * order as the rail shows them: Build · AI · Bundle. The LABEL later comes from that
 * register, so that the lane on the map cannot be named differently from the heading
 * on the rail. Only the band coordinates stand here.
 */
export const MAP_LANES: readonly Readonly<{ id: string; y: number; h: number }>[] = Object.freeze([
    Object.freeze({ id: 'build', y: 8, h: 236 }),
    Object.freeze({ id: 'ai', y: 260, h: 158 }),
    Object.freeze({ id: 'bundle', y: 434, h: 92 }),
]);

/**
 * Kinds that shared/kindColors.js DOES give a colour, but that do not belong here:
 * they are not a building block that you make in Studio. The drift test checks the map
 * against KIND_KEYS MINUS this list — a new kind must therefore either be on the plate,
 * or here with a reason. Silent omission is not possible.
 *
 *   compliance — an area that you MANAGE, not a thing that you make. It lives in
 *                organisation settings (Compliance Center, Sep 2026) and is in
 *                kindColors only so that the header, the tile in the settings nav and
 *                its own rail share one token.
 */
export const KINDS_OFF_MAP: readonly string[] = Object.freeze(['compliance']);

/**
 * The twelve building blocks. `kind` is the key from shared/kindColors.js; colour,
 * glyph and tile shape come from there, the label and the counter from the Studio
 * register (see blockMeta). x/y are hand-chosen: column a=28, b=262, c=496, and the
 * row heights per lane.
 */
export const MAP_BLOCKS: readonly MapBlock[] = Object.freeze([
    Object.freeze({ id: 'form', kind: 'form', lane: 'build', x: 28, y: 38 }),
    Object.freeze({ id: 'webpage', kind: 'webpage', lane: 'build', x: 28, y: 100 }),
    Object.freeze({ id: 'app', kind: 'app', lane: 'build', x: 28, y: 162 }),
    Object.freeze({ id: 'automation', kind: 'automation', lane: 'build', x: 262, y: 100 }),
    Object.freeze({ id: 'datatable', kind: 'datatable', lane: 'build', x: 496, y: 38 }),
    // Column c, middle row: the automation in the centre fans out to the right to table
    // (above), document (straight ahead) and approval (below). The free place in column
    // b lay in the path from app→approval — the geometry test in studioMap.test.js
    // caught that.
    Object.freeze({ id: 'document', kind: 'document', lane: 'build', x: 496, y: 100 }),
    Object.freeze({ id: 'meeting', kind: 'meeting', lane: 'ai', x: 28, y: 282 }),
    Object.freeze({ id: 'kb', kind: 'kb', lane: 'ai', x: 262, y: 282 }),
    Object.freeze({ id: 'agent', kind: 'agent', lane: 'ai', x: 28, y: 356 }),
    Object.freeze({ id: 'skill', kind: 'skill', lane: 'ai', x: 496, y: 356 }),
    Object.freeze({ id: 'playbook', kind: 'playbook', lane: 'bundle', x: 262, y: 464 }),
    Object.freeze({ id: 'solution', kind: 'solution', lane: 'bundle', x: 28, y: 464 }),
]);

/**
 * The last box, and the only one that is NOT a building block.
 *
 * Two of the twelve edges point to an approval, and an approval is nothing that you
 * MAKE: it exists only at the moment an app or an automation asks for it.
 * server/projects/graph.js draws it for the same reason as a SYNTHETIC node
 * (graph.js:32-40). Omitting it would make the map two edges poorer and conceal the
 * most important property of both: that a human stands between them. It therefore
 * receives a dotted box without a kind colour, and never a counter — approvals are
 * not counted.
 */
export const MAP_SYNTHETIC: readonly MapNode[] = Object.freeze([
    Object.freeze({
        id: 'approval', kind: null, synthetic: true, lane: 'build', x: 496, y: 162,
        labelKey: 'studio.map.approval', labelFallback: 'Approval',
    }),
]);

/** Elke getekende doos, bouwsteen of niet. */
export const MAP_NODES: readonly MapNode[] = Object.freeze([...MAP_BLOCKS, ...MAP_SYNTHETIC]);

const NODE_BY_ID = new Map<string, MapNode>(MAP_NODES.map((n): [string, MapNode] => [n.id, n]));

/** De doos met dit id, of null. */
export function mapNode(id: string): MapNode | null {
    return NODE_BY_ID.get(id) || null;
}

/* ── De twaalf randen ───────────────────────────────────────────────────────── */

/**
 * The nine verbs that run over the twelve edges. One edge carries two of them (an
 * automation READS and WRITES a table): those are two different risks on the same
 * connection, and graph.js therefore keeps them apart within one pair as well.
 */
export const VERB_LABEL: Readonly<Record<string, Readonly<{ labelKey: string; labelFallback: string }>>> = Object.freeze({
    runs: Object.freeze({ labelKey: 'studio.map.verb_runs', labelFallback: 'runs' }),
    asks: Object.freeze({ labelKey: 'studio.map.verb_asks', labelFallback: 'asks' }),
    calls: Object.freeze({ labelKey: 'studio.map.verb_calls', labelFallback: 'calls' }),
    reads: Object.freeze({ labelKey: 'studio.map.verb_reads', labelFallback: 'reads' }),
    writes: Object.freeze({ labelKey: 'studio.map.verb_writes', labelFallback: 'writes' }),
    uses: Object.freeze({ labelKey: 'studio.map.verb_uses', labelFallback: 'uses' }),
    grounds: Object.freeze({ labelKey: 'studio.map.verb_grounds', labelFallback: 'grounds' }),
    feeds: Object.freeze({ labelKey: 'studio.map.verb_feeds', labelFallback: 'feeds' }),
    triggers: Object.freeze({ labelKey: 'studio.map.verb_triggers', labelFallback: 'triggers' }),
});

/**
 * The eleven edges, in the order in which server/projects/graph.js lists them in its
 * own docblock (graph.js:22-31, plus the app→table edge that the code knows and the
 * docblock does not mention). That way this list can be checked by hand against that
 * one. Each edge is a KIND of connection that already exists on disk, not an invented
 * relationship.
 *
 * The app→table edge is the only one that today yields zero instances, and graph.js
 * MENTIONS it in its own docblock (graph.js:50-55) precisely to say that it is not
 * drawn as long as `SAVE_PATHS.app` in automation/usageSync is empty. That is a FACT
 * about the product, not a stub: as a KIND of connection it exists, so it belongs on a
 * legend — with, on the tile, the note that the product does not yet record it
 * anywhere (studio.map.edge_app_uses_datatable_note).
 */
export const MAP_EDGES: readonly MapEdge[] = Object.freeze([
    Object.freeze({
        id: 'app-runs-automation', from: 'app', to: 'automation', verbs: ['runs'],
        labelKey: 'studio.map.edge_app_runs_automation',
        labelFallback: 'An app runs an automation.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: -8 }),
    }),
    Object.freeze({
        id: 'app-asks-approval', from: 'app', to: 'approval', verbs: ['asks'],
        labelKey: 'studio.map.edge_app_asks_approval',
        labelFallback: 'An app asks a person to approve.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: 8 }),
    }),
    Object.freeze({
        id: 'automation-asks-approval', from: 'automation', to: 'approval', verbs: ['asks'],
        labelKey: 'studio.map.edge_automation_asks_approval',
        labelFallback: 'An automation asks a person to approve.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: 8 }),
    }),
    Object.freeze({
        id: 'automation-calls-automation', from: 'automation', to: 'automation', verbs: ['calls'],
        labelKey: 'studio.map.edge_automation_calls_automation',
        labelFallback: 'An automation calls another automation.',
        route: Object.freeze({ type: 'self' }),
        labelAt: Object.freeze({ x: 342, y: 60 }),
    }),
    Object.freeze({
        id: 'webpage-runs-automation', from: 'webpage', to: 'automation', verbs: ['runs'],
        labelKey: 'studio.map.edge_webpage_runs_automation',
        labelFallback: 'A web page runs an automation.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
    Object.freeze({
        // One pair, two verbs — reading and writing are not the same risk, and the map may
        // not summarise them as “uses”.
        id: 'automation-datatable', from: 'automation', to: 'datatable', verbs: ['reads', 'writes'],
        labelKey: 'studio.map.edge_automation_datatable',
        labelFallback: 'An automation reads and writes a table.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: -8 }),
    }),
    Object.freeze({
        id: 'automation-writes-document', from: 'automation', to: 'document', verbs: ['writes'],
        labelKey: 'studio.map.edge_automation_writes_document',
        labelFallback: 'An automation writes a document.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
    Object.freeze({
        id: 'app-uses-datatable', from: 'app', to: 'datatable', verbs: ['uses'],
        labelKey: 'studio.map.edge_app_uses_datatable',
        labelFallback: 'An app uses a table.',
        // The only edge with a footnote: it exists as a kind, but nothing in the product
        // records it today, and whoever goes looking for it in the Flow tab finds nothing
        // there.
        noteKey: 'studio.map.edge_app_uses_datatable_note',
        noteFallback: 'Not recorded anywhere yet, so no solution shows it.',
        // Om de automatisering heen: onderlangs en dan door de kolomgang omhoog.
        route: Object.freeze({
            type: 'elbow', fromSide: 'bottom', toSide: 'left',
            via: Object.freeze([Object.freeze({ y: 224 }), Object.freeze({ x: 459 })]),
        }),
        labelAt: Object.freeze({ x: 290, y: 219 }),
    }),
    Object.freeze({
        id: 'agent-grounds-kb', from: 'agent', to: 'kb', verbs: ['grounds'],
        labelKey: 'studio.map.edge_agent_grounds_kb',
        labelFallback: 'An agent is grounded in a knowledge base.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: -10 }),
    }),
    Object.freeze({
        id: 'agent-uses-skill', from: 'agent', to: 'skill', verbs: ['uses'],
        labelKey: 'studio.map.edge_agent_uses_skill',
        labelFallback: 'An agent uses a skill.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: 8 }),
    }),
    Object.freeze({
        id: 'meeting-feeds-kb', from: 'meeting', to: 'kb', verbs: ['feeds'],
        labelKey: 'studio.map.edge_meeting_feeds_kb',
        labelFallback: 'A meeting note feeds a knowledge base.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
    Object.freeze({
        id: 'form-triggers-automation', from: 'form', to: 'automation', verbs: ['triggers'],
        labelKey: 'studio.map.edge_form_triggers_automation',
        labelFallback: 'A form triggers an automation.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
]);

/**
 * The box without edges. Today precisely one ('solution'), and the sentence below it
 * is written for that one (“the box that the others travel in”). An eleventh kind that
 * landed on the map without edges would otherwise be told that it is a solution, so
 * the sentence hangs on the node and not on the number 0.
 */
export const NO_EDGE_NODE_ID = 'solution';

/** The edges that touch this box — out or in. A self-loop counts once. */
export function edgesOf(nodeId: string | null | undefined): MapEdge[] {
    if (!nodeId) return [];
    return MAP_EDGES.filter((e) => e.from === nodeId || e.to === nodeId);
}

/** Raakt deze rand deze doos? De zelflus raakt haar eigen doos. */
export function edgeTouches(edge: MapEdge | null | undefined, nodeId: string | null | undefined): boolean {
    return !!edge && !!nodeId && (edge.from === nodeId || edge.to === nodeId);
}

/* ── The register: label, counter and lane do NOT come from this file ───────── */

/**
 * What the register knows about this building block: what it is called, which counter
 * belongs to it, and under which lane it falls. Everything is derived, nothing
 * overwritten — otherwise a table on the map would be named differently from one on
 * the rail.
 *
 * `countKey` follows the rule of the rail (`countKey || id`), so the tile reads the
 * same key from GET /api/studio/counts as the row beside it. null for a kind that the
 * register does not (any more) know — the drift test raises an alarm about that before
 * anyone sees it on screen.
 */
export function blockMeta(kind: string | null | undefined): BlockMeta | null {
    const app = studioAppForKind(kind);
    if (!app) return null;
    return {
        // The WHOLE register record travels along, so that the drawing can request the name
        // via studioSectionLabel instead of rebuilding labelKey/labelFallback itself — that
        // third copy already lacked the runtime-module branch.
        app,
        id: app.id,
        labelKey: app.labelKey,
        labelFallback: app.labelFallback || null,
        countKey: app.countKey || app.id,
        urlSegment: app.urlSegment || null,
        category: app.category || null,
    };
}

/** De laan (categorie) uit het register, voor het label boven de band. */
export function laneMeta(laneId: string) {
    return STUDIO_CATEGORIES.find((c) => c.id === laneId) || null;
}

/* ── Tegel-chrome: het bestaande recept, met kindColors ───────────────────── */

/**
 * The outline of a tile.
 *
 * THE RECIPE IS NOT NEW: `cardChrome` from the builder canvas
 * (automation/Builder/flow/nodeTypeColors.js:183) supplies border, shadow and the
 * selection ring, with the order in which those override one another. What cardChrome
 * cannot know is that a Studio KIND is not a step family: its 4px bar and its corner
 * radius come from the step vocabulary. Those two — and only those two — come from
 * kindColors here, so that a table on this map has the same colour and the same shape
 * as on the rail and in the builder.
 *
 * The first boxShadow layer IS that family bar (nodeTypeColors.js:195:
 * `inset 4px 0 0 <bar>`); it is replaced, the rest remains. studioMap.test.js pins
 * that, so that a rebuild of cardChrome does not silently overwrite the wrong layer
 * here.
 */
export function kindCardChrome(kind: string | null | undefined, { selected = false, dimmed = false }: { selected?: boolean; dimmed?: boolean } = {}) {
    const { style } = cardChrome({ group: null, selected });
    const layers = String(style.boxShadow).split(', ');
    layers[0] = `inset 4px 0 0 ${kindColorVar(kind)}`;
    return {
        ...style,
        borderRadius: kindCardRadius(kind),
        boxShadow: layers.join(', '),
        opacity: dimmed ? 0.4 : style.opacity,
    };
}

/**
 * The outline of the synthetic box.
 *
 * `disabled` from the same recipe: dotted and muted is precisely how the canvas says
 * “this is not an ordinary card”. On selection the muting goes away — a selected box
 * that you cannot read is not a selection.
 */
export function syntheticCardChrome({ selected = false, dimmed = false }: { selected?: boolean; dimmed?: boolean } = {}) {
    const { style } = cardChrome({ group: null, disabled: true, selected });
    return {
        ...style,
        borderRadius: '8px',
        opacity: dimmed ? 0.3 : (selected ? 1 : style.opacity),
    };
}

/* ── Paden ────────────────────────────────────────────────────────────────── */

const SIDE_NORMAL: Readonly<Record<Side, Readonly<Point>>> = Object.freeze({
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 }),
    top: Object.freeze({ x: 0, y: -1 }),
    bottom: Object.freeze({ x: 0, y: 1 }),
});

/**
 * The point on the edge of a box. `off` slides ALONG that edge: two edges that leave
 * the same box on the same side must not lie on top of each other.
 */
export function anchorOf(node: Point, side: Side | undefined, off = 0): Point {
    const cx = node.x + TILE_W / 2;
    const cy = node.y + TILE_H / 2;
    if (side === 'left') return { x: node.x, y: cy + off };
    if (side === 'right') return { x: node.x + TILE_W, y: cy + off };
    if (side === 'top') return { x: cx + off, y: node.y };
    if (side === 'bottom') return { x: cx + off, y: node.y + TILE_H };
    return { x: cx, y: cy };
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** De richting waarin de pijlpunt wijst, uit de laatste twee punten. */
function direction(from: Point, to: Point): Point {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

/**
 * The arrowhead: a triangle with its point ON the end point. Deliberately not an SVG
 * marker — a marker does not inherit the stroke colour everywhere, and on this map that
 * colour changes at every selection.
 */
function arrowPath(point: Point, dir: Point, size = 6): string {
    const bx = point.x - dir.x * size;
    const by = point.y - dir.y * size;
    const px = -dir.y * size * 0.55;
    const py = dir.x * size * 0.55;
    return `M ${round1(point.x)} ${round1(point.y)} L ${round1(bx + px)} ${round1(by + py)} L ${round1(bx - px)} ${round1(by - py)} Z`;
}

/** Een orthogonale polylijn met afgeronde hoeken. */
function roundedPolyline(points: Point[], r = 8): string {
    if (points.length < 2) return '';
    let d = `M ${round1(points[0].x)} ${round1(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1];
        const cur = points[i];
        const next = points[i + 1];
        const inDir = direction(prev, cur);
        const outDir = direction(cur, next);
        const rIn = Math.min(r, Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2);
        const rOut = Math.min(r, Math.hypot(next.x - cur.x, next.y - cur.y) / 2);
        const a = { x: cur.x - inDir.x * rIn, y: cur.y - inDir.y * rIn };
        const b = { x: cur.x + outDir.x * rOut, y: cur.y + outDir.y * rOut };
        d += ` L ${round1(a.x)} ${round1(a.y)} Q ${round1(cur.x)} ${round1(cur.y)} ${round1(b.x)} ${round1(b.y)}`;
    }
    const end = points[points.length - 1];
    d += ` L ${round1(end.x)} ${round1(end.y)}`;
    return d;
}

/** De zelflus: een boog over de eigen tegel heen. */
function selfGeometry(node: Point) {
    const left = { x: node.x + 40, y: node.y };
    const right = { x: node.x + TILE_W - 40, y: node.y };
    const top = node.y - 42;
    const d = `M ${left.x} ${left.y} C ${left.x} ${top}, ${right.x} ${top}, ${right.x} ${right.y}`;
    return {
        d,
        mid: { x: (left.x + 3 * left.x + 3 * right.x + right.x) / 8, y: (left.y + 3 * top + 3 * top + right.y) / 8 },
        tip: right,
        dir: { x: 0, y: 1 },
    };
}

/** De omweg: een orthogonale route langs handgelegde knikken. */
function elbowGeometry(a: Point, b: Point, route: ElbowRoute, edge: MapEdge): EdgeGeometry {
    const pts: Point[] = [a];
    for (const via of route.via || []) {
        const last = pts[pts.length - 1];
        pts.push({ x: via.x ?? last.x, y: via.y ?? last.y });
    }
    // De laatste hoek volgt de kant waar de rand BINNENKOMT: bij links of
    // rechts nadert hij horizontaal, bij boven of onder verticaal.
    const last = pts[pts.length - 1];
    const horizontalApproach = route.toSide === 'left' || route.toSide === 'right';
    pts.push(horizontalApproach ? { x: last.x, y: b.y } : { x: b.x, y: last.y });
    pts.push(b);
    const dir = direction(pts[pts.length - 2], b);
    return {
        d: roundedPolyline(pts),
        arrow: arrowPath(b, dir),
        mid: edge.labelAt || pts[Math.floor(pts.length / 2)],
    };
}

/**
 * De bocht: een cubic bezier met raaklijnen loodrecht op de twee randen. De
 * lengte van die raaklijn schaalt mee met de afstand, en is begrensd: op een
 * korte rand duwt een lange raaklijn de bocht terug door zichzelf heen.
 */
function curveGeometry(a: Point, b: Point, route: CurveRoute, edge: MapEdge): EdgeGeometry {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const bow = route.bow ?? Math.max(20, Math.min(80, span * 0.4));
    const n1 = SIDE_NORMAL[route.fromSide] || SIDE_NORMAL.right;
    const n2 = SIDE_NORMAL[route.toSide] || SIDE_NORMAL.left;
    const c1 = { x: a.x + n1.x * bow, y: a.y + n1.y * bow };
    const c2 = { x: b.x + n2.x * bow, y: b.y + n2.y * bow };
    const mid = {
        x: round1((a.x + 3 * c1.x + 3 * c2.x + b.x) / 8),
        y: round1((a.y + 3 * c1.y + 3 * c2.y + b.y) / 8),
    };
    return {
        d: `M ${round1(a.x)} ${round1(a.y)} C ${round1(c1.x)} ${round1(c1.y)}, ${round1(c2.x)} ${round1(c2.y)}, ${round1(b.x)} ${round1(b.y)}`,
        arrow: arrowPath(b, direction(c2, b)),
        mid: edge.labelAt || mid,
    };
}

/**
 * The path of one edge: `{ d, arrow, mid }`.
 *
 * Pure geometry on the hand-chosen coordinates — no layout engine, no measurement in
 * the DOM. That is why every path can be recalculated in a test, and why the map draws
 * the same in a test as in a browser.
 */
export function edgeGeometry(edge: MapEdge): EdgeGeometry | null {
    const from = mapNode(edge?.from);
    const to = mapNode(edge?.to);
    if (!from || !to) return null;
    const route = edge.route || { type: 'curve', fromSide: 'right', toSide: 'left' };
    if (route.type === 'self') {
        const g = selfGeometry(from);
        return { d: g.d, arrow: arrowPath(g.tip, g.dir), mid: edge.labelAt || g.mid };
    }
    const a = anchorOf(from, route.fromSide, route.fromOff || 0);
    const b = anchorOf(to, route.toSide, route.toOff || 0);
    return route.type === 'elbow' ? elbowGeometry(a, b, route, edge) : curveGeometry(a, b, route, edge);
}

/** Alle randen met hun pad, in tekenvolgorde. Randen zonder doos vallen weg. */
export function edgeGeometries(): { edge: MapEdge; geometry: EdgeGeometry | null }[] {
    return MAP_EDGES.map((edge) => ({ edge, geometry: edgeGeometry(edge) })).filter((e) => e.geometry);
}

/** De soorten die de kaart tekent — waar de drifttest tegenaan legt. */
export const MAP_KINDS: readonly string[] = Object.freeze(MAP_BLOCKS.map((b) => b.kind));

/* ── Tellers ──────────────────────────────────────────────────────────────── */

/**
 * The state of the counter of one box, in four values.
 *
 * `counts` null has TWO incompatible causes, and this file may not lump them together:
 * the answer is still on its way ('pending'), or it never came ('unknown'). The hook
 * delivers that difference as `failed` — without it, a 500 would appear on the screen
 * as “The number is not in yet”, a promise that is never kept, because the card
 * deliberately runs without a poller. Unknown narrows: when in doubt, the dash and the
 * sentence that says it is not there, never the reassurance that it still comes.
 *
 * GET /api/studio/counts OMITS A KEY if the caller may not see it, and if the store
 * beneath it fell over, and it strips its own `partial` flag — the client cannot tell
 * those two apart, and both are not zero. `countFor` is the rail's derivation, not a
 * second one: garbage in the answer remains “unknown”.
 *
 * A kind that the register does NOT (any more) know is also 'unknown', not
 * 'not_counted': “nothing here can be counted” is an established fact and belongs only
 * to the synthetic box, which by construction is not counted.
 */
export function countState(node: MapNode | null | undefined, counts: StudioCounts | null | undefined, { failed = false }: { failed?: boolean } = {}): CountState {
    if (!node) return { state: 'unknown' };
    if (node.synthetic) return { state: 'not_counted' };
    const meta = blockMeta(node.kind);
    if (!meta || !meta.countKey) return { state: 'unknown' };
    if (!counts) return { state: failed ? 'unknown' : 'pending' };
    const value = countFor(counts, meta.countKey);
    return typeof value === 'number' ? { state: 'known', value } : { state: 'unknown' };
}

/**
 * The keys that GET /api/studio/counts REALLY counts org-wide.
 *
 * One, today. The rest counts per user, with the scoping of its own list route:
 * `automations` is `WHERE user_id = $1`, `runs` are the caller's own runs (with a
 * comment there saying that counting org-wide would be wrong), `solutions` is
 * listUserProjects. The endpoint moreover has NO scope parameter at all — a strip that
 * passes 'org' does not change the numbers, only the sentence under them. Without this
 * list, that sentence would flip into an org-wide claim about a number that the source
 * cannot carry: “9 · Counting everything in the organisation” under the nine own
 * automations of one builder.
 */
const ORG_WIDE_COUNT_KEYS: readonly string[] = Object.freeze(['agents']);

/**
 * The sentence that says what the number is about.
 *
 * Unknown narrows (runScope.js:20-25 keeps the same rule on the filter side): only the
 * literal value 'org' yields the org-wide sentence. Anything we do not recognise falls
 * back to what is in any case true — that the endpoint counts what THIS caller may see.
 * And 'org' also narrows, per key: a counter that the server does not count org-wide
 * gets the visible sentence, however broad the strip above it is.
 */
export function scopeSentence(t: Translate, scope: string | null | undefined, countKey: string | null = null): string {
    const visible = () => t('studio.map.scope_visible', 'Counting what you can see.');
    if (scope === 'org') {
        return (ORG_WIDE_COUNT_KEYS as readonly (string | null)[]).includes(countKey)
            ? t('studio.map.scope_org', 'Counting everything in the organisation.')
            : visible();
    }
    if (scope === 'mine') return t('studio.map.scope_mine', 'Counting only what you made.');
    if (scope === 'solution') return t('studio.map.scope_solution', 'Counting what is in the chosen solution.');
    return visible();
}
