import { toolLayoutHeights } from './aiToolNodes';
import { COL_PITCH, ROW_PITCH } from './buildChoreography';
import { isInlineId } from './inlineFlowlets';

/**
 * Where a step that was just added or spliced in lands.
 *
 * Positions are stored per step and, once every node has one, the canvas never
 * re-lays-out (see layout.js), so a new step's position is a promise: nothing
 * else moves it. The insert paths used to hand it the midpoint of the clicked
 * edge (the "+" on a connection) or the source's position plus an arbitrary
 * offset, which put the new card on top of its neighbours.
 *
 * This is the pure half: given the definition AFTER the step was added (and,
 * for a splice, after its edges were rewired), it gives the new step a free
 * column right of its source and, for a splice, makes room by moving the
 * downstream cards of the same row to the right. It never touches a position
 * the author set by hand on anything that is not downstream of the splice.
 */

const CARD_W = 240;
const CARD_H = 96;
/** Vertical pitch between stacked siblings in one rank: card + nodesep. */
const STACK_PITCH = CARD_H + 64;
/** Breathing room kept between two cards before they count as touching. */
const PAD = 8;
/** Cap on how far down a new card is pushed looking for a free slot. */
const MAX_SLOTS = 40;

interface Pos { x: number; y: number }
interface Node { id: string; type?: string; position?: Pos; [key: string]: unknown }
interface Edge { from?: string; to?: string }
interface Def { trigger?: Node; triggers?: Node[]; steps?: Node[]; edges?: Edge[]; [key: string]: unknown }

export interface Rect { x: number; y: number; width: number; height: number }

/** Do two rects share any area (touching edges do not count)? */
export function rectsOverlap(a: Rect, b: Rect): boolean {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

const finitePos = (p: unknown): p is Pos => !!p
    && typeof (p as Pos).x === 'number' && typeof (p as Pos).y === 'number'
    && Number.isFinite((p as Pos).x) && Number.isFinite((p as Pos).y);

/** The positioned, real (not note, not folded-in inline) nodes of a graph. */
function layoutNodes(def: Def): Node[] {
    return [def.trigger, ...(def.triggers || []), ...(def.steps || [])]
        .filter((n): n is Node => !!n && !!n.id && n.type !== 'note' && !isInlineId(n.id) && finitePos(n.position));
}

/** Every node reachable from `startId` by following edges forward. */
function downstreamOf(edges: Edge[], startId: string): Set<string> {
    const adj = new Map<string, string[]>();
    for (const e of edges) {
        if (!e?.from || !e?.to) continue;
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from)!.push(e.to);
    }
    const seen = new Set<string>();
    const stack = [startId];
    while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur)) continue;
        seen.add(cur);
        for (const next of adj.get(cur) || []) stack.push(next);
    }
    return seen;
}

/**
 * Give `insertedId` a non-overlapping position next to `sourceId`.
 *
 * - append (no `targetId`): the first free slot one column right of the source,
 *   walking down past siblings that already sit there;
 * - splice (`targetId`): same slot, and when the target is too close to fit a
 *   column between, every downstream card on the source's row slides right by
 *   exactly the missing distance (so a roomy hand-arranged gap is left alone).
 *
 * `keepIfFree` keeps a position the author chose (a drop point) when it is
 * already clear of every other card, and only moves the step when it is not.
 *
 * Returns the definition unchanged when it cannot say where the source is.
 */
export function placeNewStep(
    def: Def,
    insertedId: string,
    { sourceId, targetId = null, keepIfFree = false }: { sourceId?: string | null; targetId?: string | null; keepIfFree?: boolean },
): Def {
    if (!def || !insertedId || !sourceId) return def;
    const nodes = layoutNodes(def);
    const src = nodes.find(n => n.id === sourceId);
    const inserted = (def.steps || []).find(s => s.id === insertedId);
    if (!src || !inserted) return def;
    const sp = src.position as Pos;

    const heights = toolLayoutHeights(nodes, CARD_H) as Map<string, number>;
    const heightOf = (id: string) => heights.get(id) ?? CARD_H;
    if (keepIfFree && !targetId && finitePos(inserted.position)) {
        const ip = inserted.position;
        const mine = { x: ip.x, y: ip.y, width: CARD_W, height: heightOf(insertedId) };
        const clear = !nodes.some(n => n.id !== insertedId
            && rectsOverlap(mine, { x: (n.position as Pos).x - PAD, y: (n.position as Pos).y - PAD, width: CARD_W + 2 * PAD, height: heightOf(n.id) + 2 * PAD }));
        if (clear) return def;
    }
    const sameRow = (p: Pos) => Math.abs(p.y - sp.y) < ROW_PITCH / 2;

    const newX = sp.x + COL_PITCH;
    const shifted = new Map<string, Pos>();

    if (targetId) {
        const target = nodes.find(n => n.id === targetId);
        const tp = target?.position;
        if (target && tp && sameRow(tp) && tp.x > sp.x) {
            // The target must start a full column after the new card.
            const dx = Math.max(0, newX + COL_PITCH - tp.x);
            if (dx > 0) {
                const down = downstreamOf(def.edges || [], targetId);
                down.delete(sourceId);
                down.delete(insertedId);
                for (const n of nodes) {
                    const p = n.position as Pos;
                    if (down.has(n.id) && sameRow(p) && p.x > sp.x) shifted.set(n.id, { x: p.x + dx, y: p.y });
                }
            }
        }
    }

    // First free slot in the new column, against everything as it will be.
    const others = nodes
        .filter(n => n.id !== insertedId)
        .map(n => {
            const p = shifted.get(n.id) || (n.position as Pos);
            return { x: p.x - PAD, y: p.y - PAD, width: CARD_W + 2 * PAD, height: heightOf(n.id) + 2 * PAD };
        });
    const h = heightOf(insertedId);
    let y = sp.y;
    for (let i = 0; i < MAX_SLOTS; i++) {
        const rect = { x: newX, y, width: CARD_W, height: h };
        if (!others.some(o => rectsOverlap(rect, o))) break;
        y += STACK_PITCH;
    }
    const newPos = { x: newX, y };

    const apply = (n: Node): Node => {
        if (n.id === insertedId) return { ...n, position: newPos };
        const s = shifted.get(n.id);
        return s ? { ...n, position: s } : n;
    };
    return {
        ...def,
        trigger: def.trigger ? apply(def.trigger) : def.trigger,
        ...(def.triggers ? { triggers: def.triggers.map(apply) } : {}),
        steps: (def.steps || []).map(apply),
    };
}
