import { countFor, type StudioCounts } from '../../../../hooks/useStudioCounts';
import { cardChrome } from '../../../automation/Builder/flow/nodeTypeColors';
import { cardRadius as kindCardRadius, kindColorVar } from '../../../shared/kindColors';
import { STUDIO_CATEGORIES, type Translate } from '../studioGates';
import { studioAppForKind } from '../studioNav';
import type { BlockMeta, CountState, EdgeGeometry, ElbowRoute, MapEdge, MapNode, Point, Side } from './studioMap.types';
import { TILE_W, TILE_H, NODE_BY_ID, ORG_WIDE_COUNT_KEYS } from './studioMap.constants';
import { direction, arrowPath, roundedPolyline, selfGeometry, curveGeometry } from './studioMap.helpers';
export { arrowPath } from './studioMap.helpers';
export { TILE_W, TILE_H, MAP_W, MAP_H, MAP_LANES, KINDS_OFF_MAP, MAP_BLOCKS, MAP_SYNTHETIC, MAP_NODES, VERB_LABEL, NO_EDGE_NODE_ID, MAP_KINDS, ORG_WIDE_COUNT_KEYS } from './studioMap.constants';

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

/** De doos met dit id, of null. */
export function mapNode(id: string): MapNode | null {
    return NODE_BY_ID.get(id) || null;
}

/* ── De twaalf randen ───────────────────────────────────────────────────────── */

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
