/**
 * RemoteCursorsLayer — co-editors' carets, name flags and selections.
 *
 * Rendered as a SIBLING of the editor host, never inside it: the view owns
 * every node in the host and re-renders the document when anything else
 * writes there. Carets are absolutely positioned in the host's wrapper (so
 * they scroll with the text for free) and re-measured after every document
 * render and on resize; selections are painted with the CSS Custom Highlight
 * API (RangeOverlay), with overlay rectangles where it is missing.
 *
 * The name flag shows for a few seconds after a caret moves, then folds away,
 * so a document with several people in it stays readable.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import useTranslation from '../../hooks/useTranslation';
import type { CollabPeer } from '../collab/useCollab';
import type { ModelPos } from '../engine/textIndex';
import { peerHighlightName } from '../collab/colors';
import RangeOverlay, { type RangeLayer } from './RangeOverlay';

interface PositionSource { relToPos(b64: string): ModelPos | null }

interface Props {
    view: any;
    binding: PositionSource | null;
    peers: CollabPeer[];
    container: HTMLElement | null;
    /** Changes after every document render. */
    tick: number;
}

interface Caret {
    clientId: number;
    colorIndex: number;
    name: string;
    top: number;
    left: number;
    height: number;
    flag: boolean;
}

const FLAG_MS = 3000;

function cmp(a: ModelPos, b: ModelPos): number {
    const n = Math.min(a.path.length, b.path.length);
    for (let i = 0; i < n; i += 1) if (a.path[i] !== b.path[i]) return a.path[i] - b.path[i];
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.offset - b.offset;
}

/** Screen box of a collapsed range; an empty line reports none, so use its block. */
function caretBox(range: Range): DOMRect | null {
    const rects = Array.from(range.getClientRects ? range.getClientRects() : []);
    const r = rects.find((x) => x.height > 0) || (range.getBoundingClientRect ? range.getBoundingClientRect() : null);
    if (r && r.height > 0) return r;
    let el: Node | null = range.startContainer;
    while (el && el.nodeType !== 1) el = el.parentNode;
    const box = el ? (el as Element).getBoundingClientRect() : null;
    return box && box.height > 0 ? box : null;
}

/** When each peer's caret last moved (the name flag shows for a while after). */
type MoveLog = Map<number, { key: string; at: number }>;

/** Remember a move; returns when the caret last moved. */
function noteMove(log: MoveLog, p: CollabPeer, now: number): number {
    const key = `${p.cursor!.anchor}|${p.cursor!.head}`;
    const seen = log.get(p.clientId);
    if (!seen || seen.key !== key) { log.set(p.clientId, { key, at: now }); return now; }
    return seen.at;
}

/** The caret of one peer relative to `base`, or null when it cannot be placed. */
function placeCaret(view: any, head: ModelPos, base: DOMRect): { top: number; left: number; height: number } | null {
    const caretRange: Range | null = view.rangeFor(head, head);
    const box = caretRange ? caretBox(caretRange) : null;
    return box ? { top: box.top - base.top, left: box.left - base.left, height: box.height } : null;
}

/** The DOM range a peer has selected, or null for a plain caret. */
function selectedRange(view: any, anchor: ModelPos | null, head: ModelPos): Range | null {
    if (!anchor || cmp(anchor, head) === 0) return null;
    const [from, to] = cmp(anchor, head) < 0 ? [anchor, head] : [head, anchor];
    return view.rangeFor(from, to);
}

export default function RemoteCursorsLayer({ view, binding, peers, container, tick }: Props) {
    const { t } = useTranslation();
    const unknown = t('editor.peer_unknown', 'Someone');
    const moved = useRef(new Map<number, { key: string; at: number }>());
    const [carets, setCarets] = useState<Caret[]>([]);
    const [layers, setLayers] = useState<RangeLayer[]>([]);
    const [flagClock, setFlagClock] = useState(0);

    const withCursor = useMemo(() => peers.filter((p) => p.cursor), [peers]);

    useLayoutEffect(() => {
        if (!view || !binding || !container) { setCarets([]); setLayers([]); return undefined; }
        const measure = () => {
            const base = container.getBoundingClientRect();
            const now = Date.now();
            const nextCarets: Caret[] = [];
            const byColor = new Map<number, Range[]>();
            const live = new Set<number>();
            for (const p of withCursor) {
                const head = binding.relToPos(p.cursor!.head);
                if (!head) continue;
                live.add(p.clientId);
                const movedAt = noteMove(moved.current, p, now);
                const place = placeCaret(view, head, base);
                if (place) {
                    nextCarets.push({ clientId: p.clientId, colorIndex: p.colorIndex, name: p.name || unknown, ...place, flag: now - movedAt < FLAG_MS });
                }
                const range = selectedRange(view, binding.relToPos(p.cursor!.anchor), head);
                if (range) byColor.set(p.colorIndex, [...(byColor.get(p.colorIndex) || []), range]);
            }
            for (const id of [...moved.current.keys()]) if (!live.has(id)) moved.current.delete(id);
            setCarets(nextCarets);
            setLayers([...byColor.entries()].map(([i, ranges]) => ({
                name: peerHighlightName(i), ranges, className: `bf-peer-sel bf-peer-${i}`,
            })));
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [view, binding, container, withCursor, tick, unknown, flagClock]);

    // Fold the name flags away a moment after the last move.
    useEffect(() => {
        if (!carets.some((c) => c.flag)) return undefined;
        const timer = setTimeout(() => setFlagClock((n) => n + 1), FLAG_MS);
        return () => clearTimeout(timer);
    }, [carets]);

    return (
        <>
            <RangeOverlay layers={layers} container={container} tick={tick} />
            {carets.length > 0 && (
                <div className="bf-peer-layer" aria-hidden="true">
                    {carets.map((c) => {
                        const box = { top: c.top, left: c.left, height: c.height };
                        return (
                            <div key={c.clientId} className={`bf-peer-caret bf-peer-${c.colorIndex}`} style={box}>
                                {c.flag && <span className="bf-peer-flag">{c.name}</span>}
                            </div>
                        );
                    })}
                </div>
            )}
        </>
    );
}
