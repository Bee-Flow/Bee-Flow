import type { MapBlock, MapNode, Point, Side } from './studioMap.types';

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

export const NODE_BY_ID = new Map<string, MapNode>(MAP_NODES.map((n): [string, MapNode] => [n.id, n]));

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
 * The box without edges. Today precisely one ('solution'), and the sentence below it
 * is written for that one (“the box that the others travel in”). An eleventh kind that
 * landed on the map without edges would otherwise be told that it is a solution, so
 * the sentence hangs on the node and not on the number 0.
 */
export const NO_EDGE_NODE_ID = 'solution';

export const SIDE_NORMAL: Readonly<Record<Side, Readonly<Point>>> = Object.freeze({
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 }),
    top: Object.freeze({ x: 0, y: -1 }),
    bottom: Object.freeze({ x: 0, y: 1 }),
});

/** De soorten die de kaart tekent — waar de drifttest tegenaan legt. */
export const MAP_KINDS: readonly string[] = Object.freeze(MAP_BLOCKS.map((b) => b.kind));

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
export const ORG_WIDE_COUNT_KEYS: readonly string[] = Object.freeze(['agents']);
