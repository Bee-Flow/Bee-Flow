/**
 * The map's geometry for the card's current size: the projection and the
 * country outlines (which only change on a resize), and everything placed on
 * top of them (which changes with the data). Both memoised, so a zoom tick
 * or a hover recomputes neither.
 */

import { geoPath, type GeoProjection } from 'd3-geo';
import { useEffect, useMemo, useState, type RefObject } from 'react';

import {
    buildArcs, fitTransform, trafficBounds, unionBox, type Arc, type Box, type Pt, type Size, type ZoomState,
} from './mapGeometry';
import {
    placeDestinations, receivedByCountry, worldBox, worldProjection,
    type CountryShape, type MapDestination, type MapOrigin, type Placement,
} from './mapModel';
import type { Atlas } from './useWorldAtlas';

/** The opening view's margin: the kind pills and the legend sit over the top and bottom edges. */
const HOME_PADDING = 48;

export interface MapGeo {
    projection: GeoProjection;
    shapes: CountryShape[];
    world: Box;
    size: Size;
}

export interface MapModel {
    placement: Placement;
    /** Your server in base space, or null when its location is not set. */
    origin: Pt | null;
    arcs: Arc[];
    extent: Box;
    home: ZoomState;
    homeKey: string;
    byHost: Map<string, MapDestination>;
    localHosts: Set<string>;
    localCalls: number;
    maxTotal: number;
    received: Map<string, 'eu' | 'outside'>;
}

/** The card's inner size, or null while it is too small to draw in (or not laid out, as in jsdom). */
export function useElementSize(ref: RefObject<HTMLElement | null>): Size | null {
    const [size, setSize] = useState<Size | null>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return undefined;
        const read = () => {
            const w = el.clientWidth;
            const h = el.clientHeight;
            setSize(prev => {
                if (w < 40 || h < 40) return null;
                return prev && prev.w === w && prev.h === h ? prev : { w, h };
            });
        };
        read();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(read);
        ro.observe(el);
        return () => ro.disconnect();
    }, [ref]);
    return size;
}

export function buildGeo(atlas: Atlas, size: Size): MapGeo {
    const projection = worldProjection(size);
    const path = geoPath(projection);
    const shapes = atlas.world.features.map((f, i) => ({ key: String(i), d: path(f) || '', code: f.properties?.code || null }));
    return { projection, shapes, world: worldBox(projection), size };
}

export function buildModel(geo: MapGeo, pins: Atlas['pins'], dests: MapDestination[], origin: MapOrigin | null): MapModel {
    const project = (lonLat: Pt) => geo.projection(lonLat) as Pt | null;
    const placement = placeDestinations(dests, pins, project);
    const o = origin ? project([origin.lon, origin.lat]) : null;
    const arcs = buildArcs(o, placement.placed);
    const bounds = trafficBounds(o, placement.placed, arcs);
    const extent = unionBox(geo.world, bounds);
    return {
        placement,
        origin: o,
        arcs,
        extent,
        home: fitTransform(bounds, geo.size, { extent, padding: HOME_PADDING }),
        homeKey: bounds ? bounds.flat().map(v => Math.round(v)).join(',') : 'world',
        byHost: new Map([...placement.placed, ...placement.local].map(d => [d.host, d] as [string, MapDestination])),
        localHosts: new Set(placement.local.map(d => d.host)),
        localCalls: placement.local.reduce((n, d) => n + d.total, 0),
        maxTotal: Math.max(0, ...placement.placed.map(d => d.total)),
        received: receivedByCountry(placement.placed),
    };
}

export function useMapModel(atlas: Atlas | null, size: Size | null, dests: MapDestination[], origin: MapOrigin | null) {
    const geo = useMemo(() => (atlas && size ? buildGeo(atlas, size) : null), [atlas, size]);
    const model = useMemo(
        () => (geo && atlas ? buildModel(geo, atlas.pins, dests, origin) : null),
        [geo, atlas, dests, origin],
    );
    return { geo, model };
}
