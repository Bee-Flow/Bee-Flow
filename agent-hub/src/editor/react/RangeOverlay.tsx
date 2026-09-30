/**
 * RangeOverlay — paints named sets of document ranges (find results, comment
 * anchors, co-editors' selections) next to the editor host, never inside it.
 *
 * With the CSS Custom Highlight API the ranges are registered and the browser
 * paints them (see editor.css for the ::highlight rules) — nothing is
 * rendered here. Without it, measured rectangles are drawn in an absolutely
 * positioned layer inside `container`, behind the text.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clearOwner, newHighlightOwner, paintHighlight, rectsFor, supportsHighlights, type OverlayRect } from './highlights';

export interface RangeLayer {
    /** Highlight name (must have a ::highlight rule in editor.css). */
    name: string;
    ranges: Range[];
    /** Class of the fallback rectangles. */
    className: string;
}

interface Props {
    layers: RangeLayer[];
    /** The positioned element the fallback rectangles are measured against. */
    container: HTMLElement | null;
    /** Changes whenever the document re-rendered, so rectangles are re-measured. */
    tick?: number;
}

interface PlacedRect extends OverlayRect { className: string }

export default function RangeOverlay({ layers, container, tick = 0 }: Props) {
    const owner = useMemo(() => newHighlightOwner('bf-ranges'), []);
    const native = supportsHighlights();
    const painted = useRef(new Set<string>());
    const [rects, setRects] = useState<PlacedRect[]>([]);

    useEffect(() => () => clearOwner(owner), [owner]);

    // Native: register the current ranges, and withdraw names no longer used.
    useEffect(() => {
        if (!native) return;
        const now = new Set<string>();
        for (const layer of layers) {
            now.add(layer.name);
            paintHighlight(layer.name, owner, layer.ranges);
        }
        for (const name of painted.current) if (!now.has(name)) paintHighlight(name, owner, []);
        painted.current = now;
    }, [native, layers, owner]);

    // Fallback: measure after layout, and again when the window resizes.
    useLayoutEffect(() => {
        if (native) return undefined;
        const measure = () => {
            const next: PlacedRect[] = [];
            for (const layer of layers) {
                for (const r of rectsFor(layer.ranges, container)) next.push({ ...r, className: layer.className });
            }
            setRects(next);
        };
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [native, layers, container, tick]);

    if (native || !rects.length) return null;
    return (
        <div className="bf-range-overlay" aria-hidden="true">
            {rects.map((r, i) => {
                const box = { top: r.top, left: r.left, width: r.width, height: r.height };
                return <div key={`${r.className}-${i}`} className={`bf-range-rect ${r.className}`} style={box} />;
            })}
        </div>
    );
}
