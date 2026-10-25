import { edgeKey } from './branchEdges';
import { revealSchedule, orderAdded } from './buildChoreography';
import { ROW_PITCH, BURST_WIDE_MIN } from './buildChoreography.constants';
import { flowOrder } from './flowOrder';
import type { ApplyDiffOptions, DiagramDefinition, Node, RefObject, BuildCue, ChoreographyDiff, FxEntry, FxState, PendingCard, Rect, ShotKind } from './useBuildChoreography.types';
import { FLAG_TTL_MS, CARD_W, CARD_H, MIN_FRAMEABLE_PX } from './useBuildChoreography.constants';

function expiryOf(entry: { touchedAt?: number; at: number; delayMs?: number }) {
    return (entry.touchedAt ?? entry.at) + FLAG_TTL_MS + (entry.delayMs || 0);
}

export function nextExpiry(fx: FxState) {
    let min = Infinity;
    for (const entry of fx.byId.values()) min = Math.min(min, expiryOf(entry));
    for (const at of fx.edgeKeys.values()) min = Math.min(min, at);
    return Number.isFinite(min) ? min : null;
}

/** When the next queued card's turn begins, or null with an empty queue. */
export function nextDue(pending: readonly PendingCard[]) {
    let min = Infinity;
    for (const p of pending) if (Number.isFinite(p?.at)) min = Math.min(min, p.at);
    return Number.isFinite(min) ? min : null;
}

/** Drop every flag whose time is up; the same object back when nothing expired. */
export function prune(fx: FxState, now: number): FxState {
    let changed = false;
    const byId = new Map<string, FxEntry>();
    for (const [id, entry] of fx.byId) {
        if (expiryOf(entry) <= now) changed = true;
        else byId.set(id, entry);
    }
    const edgeKeys = new Map<string, number>();
    for (const [key, at] of fx.edgeKeys) {
        if (at <= now) changed = true;
        else edgeKeys.set(key, at);
    }
    return changed ? { ...fx, byId, edgeKeys } : fx;
}

/** A node's absolute layout rect (parents added back on), or null. */
export function rectOf(nodes: Node[] | null | undefined, id?: string | null): Rect | null {
    if (!id || !Array.isArray(nodes)) return null;
    const byId = new Map<string, Node>();
    for (const n of nodes) if (n?.id != null) byId.set(n.id, n);
    const node = byId.get(id);
    if (!node?.position) return null;
    let { x, y } = node.position;
    let parent = node.parentId;
    // Bounded: a malformed parent chain must not hang the render.
    for (let hops = 0; parent && hops < 16; hops += 1) {
        const p = byId.get(parent);
        if (!p?.position) break;
        x += p.position.x;
        y += p.position.y;
        parent = p.parentId;
    }
    return {
        x, y,
        width: node.width ?? node.measured?.width ?? CARD_W,
        height: node.height ?? node.measured?.height ?? CARD_H,
    };
}

/** Every placed card as one rect — what a wide shot frames when we frame it ourselves. */
export function unionOfNodes(nodes: Node[]): Rect | null {
    let out: Rect | null = null;
    for (const n of Array.isArray(nodes) ? nodes : []) {
        const r = rectOf(nodes, n?.id);
        if (!r) continue;
        out = out ? {
            x: Math.min(out.x, r.x),
            y: Math.min(out.y, r.y),
            width: Math.max(out.x + out.width, r.x + r.width) - Math.min(out.x, r.x),
            height: Math.max(out.y + out.height, r.y + r.height) - Math.min(out.y, r.y),
        } : { ...r };
    }
    return out && out.width > 0 && out.height > 0 ? out : null;
}

const rowOf = (rect: Rect | null) => (rect ? Math.round(rect.y / ROW_PITCH) : null);

export function predecessorOf(definition: DiagramDefinition | null | undefined, id?: string | null) {
    if (!id) return null;
    for (const e of Array.isArray(definition?.edges) ? definition.edges : []) {
        if (e && e.to === id && e.from) return e.from;
    }
    return null;
}

export function lastInFlow(definition: DiagramDefinition | null | undefined) {
    const order = flowOrder(definition);
    return order.length ? order[order.length - 1] : (definition?.trigger?.id ?? null);
}

/** The ghost's caption: the narrated thought, else the first open todo, else null (the node renders its own default). */
export function captionFor(cue?: { narration?: string | null; todos?: BuildCue['todos'] } | null) {
    const narration = typeof cue?.narration === 'string' ? cue.narration.trim() : '';
    if (narration) return narration;
    const todos = Array.isArray(cue?.todos) ? cue.todos : [];
    const todo = todos.find((t: { text?: string; done?: boolean }) => t && !t.done && typeof t.text === 'string' && t.text.trim());
    return todo ? (todo.text as string).trim() : null;
}

/**
 * Which camera cut a diff earns. An addition is a push-in on its head (the
 * queue cues one per later card as it is dealt); a replace is a chapter
 * break; an update moves nothing unless the card is off-screen, which the
 * effect checks with the live viewport.
 */
function reasonFor(diff: ChoreographyDiff) {
    const { added, removed, touched } = diff;
    if (added.length) return removed.length ? 'replace' : 'arrival';
    if (removed.length) return 'remove';
    if (touched.length) return 'touched';
    return 'update';
}

/**
 * Fold one draft's diff into the flag state. Returns the same object when the
 * diff is empty — a refused call re-sends an identical definition, and that
 * must not re-render a single card.
 *
 * `orderHint` is the burst order the model itself reported (the ids of
 * `result.added`, see chat/toolCallDisplay.addedStepsOf); `flightMs` is how
 * long a ghost takes to fly from the ribbon to the card's slot. A card's
 * reveal delay is its DEPARTURE (the schedule) plus the flight, so the card
 * materialises the moment the ghost lands on it, never before.
 */
export function applyDiff(fx: FxState, diff: ChoreographyDiff, { definition, nodes, now, orderHint = null, flightMs = 0 }: ApplyDiffOptions): FxState {
    const { added, removed, touched, addedEdgeKeys } = diff;
    if (!added.length && !removed.length && !touched.length && !addedEdgeKeys.length) return fx;

    const ids = orderAdded(added, orderHint);
    const schedule = revealSchedule(ids);
    const flight = Math.max(0, Number(flightMs) || 0);
    const delayOf = (id: string) => (schedule.has(id) ? schedule.get(id).delayMs + flight : 0);

    const byId = new Map(fx.byId);
    for (const id of ids) byId.set(id, { kind: 'fresh', delayMs: delayOf(id), at: now });
    for (const id of removed) byId.delete(id);
    for (const id of touched) {
        if (schedule.has(id)) continue;
        const cur = byId.get(id);
        // Mid-reveal the summary line is already wiping in; re-flagging it as
        // touched would restart that wipe halfway and read as a stutter.
        if (cur?.kind === 'fresh' && expiryOf(cur) > now) continue;
        byId.set(id, { kind: 'touched', delayMs: 0, at: cur?.at ?? now, touchedAt: now });
    }

    // A fresh edge draws in at its TARGET card's delay (flight included), so
    // in a burst each line arrives just ahead of the card it leads to.
    const edgeKeys = new Map(fx.edgeKeys);
    const wanted = new Set(addedEdgeKeys);
    for (const e of Array.isArray(definition?.edges) ? definition.edges : []) {
        if (!e || e.from == null || e.to == null) continue;
        const key = edgeKey(e);
        if (!wanted.has(key)) continue;
        edgeKeys.set(key, now + FLAG_TTL_MS + delayOf(e.to));
    }

    // The queue: every card after the head, with the instant its turn begins.
    // A removal takes its card out of the queue too — a slot nobody will fill
    // must not keep advancing the frontier onto it. A queue still running
    // when the next diff lands is kept: its cards are already flagged with
    // their delays and still owe the film their landings.
    const removedSet = new Set(removed);
    const carried = fx.pending.filter((p: PendingCard) => !removedSet.has(p.id));
    const pending = ids.length
        ? [...carried, ...ids.slice(1).map(id => ({ id, at: now + schedule.get(id).delayMs }))]
        : carried;

    let frontierId = fx.frontierId;
    if (ids.length) {
        // The HEAD of the burst, not its last card: the frontier walks the
        // burst as the queue is dealt, so the ghost slot hops ahead of the
        // card that is landing rather than pointing past six invisible ones.
        frontierId = ids[0];
    } else if (touched.length && !pending.length) {
        // An update only moves the frontier when it lands on the very last
        // card: editing step 2 of 7 is not "the AI is now at step 2". While a
        // queue is still being dealt the queue owns the frontier — the last
        // card in flow is one the audience has not seen yet.
        const last = lastInFlow(definition);
        if (touched.includes(last)) frontierId = last;
    }
    if (frontierId && removedSet.has(frontierId)) frontierId = null;

    const prevFrontierRect = rectOf(nodes, fx.frontierId ?? predecessorOf(definition, frontierId));
    const newRect = ids.length ? rectOf(nodes, frontierId) : null;
    const rowWrapped = !!(newRect && prevFrontierRect && rowOf(newRect) !== rowOf(prevFrontierRect));

    return {
        byId,
        edgeKeys,
        frontierId,
        // The slot ahead of the frontier promises "the next card lands here".
        // After a removal or replace that promise is void until the AI adds
        // again, so the ghost steps away rather than pointing at a guess.
        ghostHidden: removed.length ? true : (ids.length ? false : fx.ghostHidden),
        pending,
        head: ids.length ? { id: ids[0], at: now } : fx.head,
        burst: ids.length ? ids.length : fx.burst,
        event: {
            seq: (fx.event?.seq || 0) + 1,
            reason: reasonFor(diff),
            rowWrapped,
            touched: touched.length ? touched[touched.length - 1] : null,
            at: now,
            burst: ids.length,
        },
    };
}

/**
 * Deal the next card(s) of the burst: every queued entry whose time has come
 * leaves the queue, the frontier moves to the last of them, and the camera
 * gets an `arrival` — or, when this emptied a burst of BURST_WIDE_MIN or more,
 * a `burst_end`, the one wide shot that closes the chapter (planCameraMove
 * already spaces it MIN_MOVE_GAP_MS from the last push). The same object back
 * when nothing was due, so a stray timer re-renders nothing.
 */
export function advance(fx: FxState, now: number, nodes: Node[]): FxState {
    const due = fx.pending.filter((p: PendingCard) => p.at <= now);
    if (!due.length) return fx;
    const pending = fx.pending.filter((p: PendingCard) => p.at > now);
    const frontierId = due[due.length - 1].id;
    const prevRect = rectOf(nodes, fx.frontierId);
    const newRect = rectOf(nodes, frontierId);
    const rowWrapped = !!(newRect && prevRect && rowOf(newRect) !== rowOf(prevRect));
    const drained = pending.length === 0;
    return {
        ...fx,
        pending,
        frontierId,
        event: {
            seq: (fx.event?.seq || 0) + 1,
            reason: drained && fx.burst >= BURST_WIDE_MIN ? 'burst_end' : 'arrival',
            rowWrapped,
            touched: null,
            at: now,
            burst: fx.burst,
        },
    };
}

/** Two camera plans due at the same instant collapse into the wider one. */
export function mergeMoves(a: ShotKind[] | null, b: ShotKind[]): ShotKind[] {
    if (!a) return b;
    if (!b) return a;
    if (a.length > 1 || b.length > 1) return ['wide', 'push'];
    if (a.includes('wide') || b.includes('wide')) return ['wide'];
    if (a.includes('push') || b.includes('push')) return ['push'];
    return a;
}

export function sizeOf(wrapperRef: RefObject<HTMLElement | null> | undefined, insetLeft = 0) {
    const box = wrapperRef?.current?.getBoundingClientRect?.();
    const width = Number(box?.width) || 0;
    const height = Number(box?.height) || 0;
    if (!(width > 0 && height > 0)) return null;
    const wanted = Math.max(0, Number(insetLeft) || 0);
    const offsetX = width - wanted >= MIN_FRAMEABLE_PX ? wanted : 0;
    return { width: width - offsetX, height, offsetX };
}
