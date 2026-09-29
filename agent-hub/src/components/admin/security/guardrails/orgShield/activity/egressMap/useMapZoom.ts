/**
 * Pan and zoom for the egress map, on d3-zoom.
 *
 * ── The page keeps its scroll wheel ───────────────────────────────────────
 * The map sits in the middle of a long pane. A map that swallows the wheel
 * traps anyone scrolling past it, so a plain wheel is left to the page and
 * only Ctrl (or Cmd) plus the wheel zooms; a trackpad pinch arrives as
 * exactly that. A plain wheel over the map reports back, and the card shows
 * a short "hold Ctrl to zoom" hint. On a touch screen one finger scrolls the
 * page and two fingers move the map, for the same reason.
 *
 * ── The camera follows the traffic until someone moves it ─────────────────
 * The first view is `home`, the fit to the traffic. While nobody has moved
 * the map, a refresh that changes the traffic re-fits it; once someone has
 * panned or zoomed, a refresh leaves their view alone. A resize always
 * re-fits, because the projection under the view changed.
 *
 * Pins, lines and the arcs' hit areas carry `data-map-hit`: a press there is
 * a click on that thing, never the start of a drag or a double-click zoom.
 */

import { select } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

import { K_MAX, K_MIN, type Box, type Size, type ZoomState } from './mapGeometry';

const DURATION = 450;
const IDENTITY: ZoomState = { k: 1, x: 0, y: 0 };

interface Options {
    size: Size | null;
    extent: Box | null;
    home: ZoomState;
    /** Changes when the traffic the home view frames has changed. */
    homeKey: string;
    reducedMotion: boolean;
    onPlainWheel?: () => void;
}

export interface MapZoom {
    transform: ZoomState;
    fit: () => void;
    world: () => void;
    zoomBy: (factor: number) => void;
    zoomTo: (t: ZoomState) => void;
}

const onHit = (target: EventTarget | null) =>
    !!(target instanceof Element && target.closest('[data-map-hit]'));

/** Which events start a gesture. Exported for its test. */
export function zoomFilter(event: Event & { ctrlKey?: boolean; metaKey?: boolean; button?: number; touches?: TouchList }, onPlainWheel?: () => void): boolean {
    if (event.type === 'wheel') {
        if (event.ctrlKey || event.metaKey) return true;
        onPlainWheel?.();
        return false;
    }
    if (event.type === 'touchstart') return (event.touches?.length || 0) > 1;
    if (onHit(event.target)) return false;
    return !event.ctrlKey && !event.button;
}

export function useMapZoom(svgRef: RefObject<SVGSVGElement | null>, opts: Options): MapZoom {
    const { size, extent, home, homeKey, reducedMotion } = opts;
    const [transform, setTransform] = useState<ZoomState>(IDENTITY);
    const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
    const userMoved = useRef(false);
    const lastSize = useRef('');
    const wheelRef = useRef(opts.onPlainWheel);
    useEffect(() => { wheelRef.current = opts.onPlainWheel; });

    const w = size?.w || 0;
    const h = size?.h || 0;
    const e = extent;

    // Attach (and re-configure on resize): the behaviour object lives as long
    // as the component, so its transform survives a re-render. Layout effects,
    // both: the first paint is already the home view, never a flash of the
    // whole world snapping to the traffic.
    useLayoutEffect(() => {
        const svg = svgRef.current;
        if (!svg || !w || !h) return undefined;
        if (!zoomRef.current) zoomRef.current = zoom<SVGSVGElement, unknown>();
        const z = zoomRef.current;
        z.scaleExtent([K_MIN, K_MAX])
            .extent([[0, 0], [w, h]])
            .translateExtent(e || [[0, 0], [w, h]])
            .filter((event: Event) => zoomFilter(event, () => wheelRef.current?.()))
            .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
                const { k, x, y } = event.transform;
                if (event.sourceEvent) userMoved.current = true;
                setTransform(prev => (prev.k === k && prev.x === x && prev.y === y ? prev : { k, x, y }));
            });
        const sel = select(svg);
        sel.call(z);
        return () => { sel.on('.zoom', null); };
    }, [svgRef, w, h, e]);

    // The home view: on the first draw, on every resize, and on a traffic
    // change for as long as nobody has moved the map.
    useLayoutEffect(() => {
        const svg = svgRef.current;
        const z = zoomRef.current;
        if (!svg || !z || !w || !h) return;
        const sizeKey = `${w}x${h}`;
        const resized = sizeKey !== lastSize.current;
        lastSize.current = sizeKey;
        if (resized) userMoved.current = false;
        else if (userMoved.current) return;
        select(svg).interrupt().call(z.transform, zoomIdentity.translate(home.x, home.y).scale(home.k));
        // `home` is keyed by homeKey on purpose: a new object with the same
        // framing must not snap the view back on every refresh.
    }, [svgRef, w, h, homeKey]);

    const run = useCallback((apply: (z: ZoomBehavior<SVGSVGElement, unknown>, animate: boolean) => void) => {
        const svg = svgRef.current;
        const z = zoomRef.current;
        if (!svg || !z) return;
        apply(z, !reducedMotion);
    }, [svgRef, reducedMotion]);

    const zoomTo = useCallback((t: ZoomState) => run((z, animate) => {
        const target = zoomIdentity.translate(t.x, t.y).scale(t.k);
        const sel = select(svgRef.current as SVGSVGElement);
        if (animate) sel.transition().duration(DURATION).call(z.transform, target);
        else sel.call(z.transform, target);
        userMoved.current = true;
    }), [run, svgRef]);

    const zoomBy = useCallback((factor: number) => run((z, animate) => {
        const sel = select(svgRef.current as SVGSVGElement);
        if (animate) sel.transition().duration(DURATION).call(z.scaleBy, factor);
        else sel.call(z.scaleBy, factor);
        userMoved.current = true;
    }), [run, svgRef]);

    const fit = useCallback(() => {
        zoomTo(home);
        // Back on the traffic: from here a refresh may re-fit again.
        userMoved.current = false;
    }, [zoomTo, home]);

    const world = useCallback(() => zoomTo(IDENTITY), [zoomTo]);

    return { transform, fit, world, zoomBy, zoomTo };
}
