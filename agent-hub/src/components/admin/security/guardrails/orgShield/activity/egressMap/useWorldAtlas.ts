/**
 * The world outline and the country pins, loaded when the map first renders.
 *
 * Both are committed files (scripts/build-world-atlas.mjs) and dynamically
 * imported, so their ~150 KB stay out of the main bundle and nothing is
 * fetched from a CDN. On the one screen whose subject is that data does not
 * leave the building, the screen itself must not phone out.
 */

import type { FeatureCollection, Geometry } from 'geojson';
import { useEffect, useState } from 'react';

export interface Atlas {
    world: FeatureCollection<Geometry, { name: string; code: string | null }>;
    pins: Record<string, number[]>;
}

let cached: Promise<Atlas> | null = null;

function load(): Promise<Atlas> {
    if (!cached) {
        cached = Promise.all([import('./worldAtlas.json'), import('./countryPins.json')])
            .then(([world, pins]) => ({
                world: ((world as { default?: unknown }).default || world) as Atlas['world'],
                pins: ((pins as { default?: unknown }).default || pins) as Atlas['pins'],
            }))
            .catch((e) => { cached = null; throw e; });
    }
    return cached;
}

/** null while loading, and if loading failed: the list beside the map still shows everything. */
export function useWorldAtlas(): Atlas | null {
    const [atlas, setAtlas] = useState<Atlas | null>(null);
    useEffect(() => {
        let live = true;
        load().then(a => { if (live) setAtlas(a); }).catch(() => { /* the list stands in for the map */ });
        return () => { live = false; };
    }, []);
    return atlas;
}
