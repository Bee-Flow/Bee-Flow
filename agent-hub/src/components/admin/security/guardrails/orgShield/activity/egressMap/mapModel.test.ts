/**
 * The egress map, asserted on numbers rather than on drawn SVG.
 *
 * The load-bearing test is the fit: the old map framed a Mercator band from
 * 60°N to 40°S with no clip, so the pin in Canada sat on the card's top edge
 * and its line ran off it, and New Zealand was counted as placed but drawn
 * off the canvas. The opening view must now contain every line WHOLE,
 * control point included, at the sizes the card actually takes.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/activity/egressMap/mapModel.test.ts
 */

import { describe, expect, it } from 'vitest';

import { REGION_FILL } from '../../shieldPalette';
import pins from './countryPins.json';
import { applyZoom, buildArcs, fitTransform, trafficBounds, unionBox, type Pt, type Size } from './mapGeometry';
import {
    countryFill, EEA_CODES, lineStyle, lineWidth, PIN_REF_CALLS, pinRadius, placeDestinations, receivedByCountry,
    toMapDestination, toMapDestinations, worldBox, worldProjection, type RawDestination,
} from './mapModel';

const PINS = pins as Record<string, number[]>;
const NL: Pt = [4.9, 52.37];

const dest = (over: RawDestination) => toMapDestination({ dest_host: 'x.example', total: 10, ...over });

describe('toMapDestination', () => {
    it('reads the overview contract', () => {
        expect(dest({
            location_state: 'via_network', location_basis: 'edge_header', city: 'Amsterdam', lat: '52.31', lon: 4.76,
            edge_pop: 'ams', network: 'Cloudflare', country_code: 'nl', pii_events: 3, sample_peer_ip: '104.18.24.82',
        })).toMatchObject({
            host: 'x.example', state: 'via_network', basis: 'edge_header', city: 'Amsterdam', lat: 52.31, lon: 4.76,
            edgePop: 'AMS', network: 'Cloudflare', countryCode: 'NL', piiEvents: 3, peerIp: '104.18.24.82', total: 10,
        });
    });

    it('derives a state for a server that predates the location columns', () => {
        expect(dest({ is_local: true, is_eu: true }).state).toBe('local');
        expect(dest({ is_eu: true, country_code: 'DE' }).state).toBe('eu');
        expect(dest({ country_code: 'US' }).state).toBe('outside');
        expect(dest({}).state).toBe('unknown');
        expect(dest({ location_state: 'nonsense', country_code: 'US' }).state).toBe('outside');
    });

    it('drops coordinates that are not coordinates', () => {
        expect(dest({ lat: 0, lon: 0 })).toMatchObject({ lat: null, lon: null });
        expect(dest({ lat: 95, lon: 10 })).toMatchObject({ lat: null, lon: null });
        expect(dest({ lat: 50, lon: null })).toMatchObject({ lat: null, lon: null });
    });

    it('keeps one row per host and drops rows without one', () => {
        const list = toMapDestinations([{ dest_host: 'a' }, { dest_host: 'a', total: 9 }, { total: 4 }, { tls_servername: 'b' }]);
        expect(list.map(d => d.host)).toEqual(['a', 'b']);
    });
});

describe('the country pins', () => {
    it('puts France in France, not in Spain', () => {
        // The centroid of the whole MultiPolygon included French Guiana.
        const [lon, lat] = PINS.FR;
        expect(lon).toBeGreaterThan(-2);
        expect(lon).toBeLessThan(8);
        expect(lat).toBeGreaterThan(43);
        expect(lat).toBeLessThan(50);
    });

    it('has a pin for every country the EEA set names, and for the far places', () => {
        for (const code of [...EEA_CODES, 'US', 'CA', 'NZ', 'AU', 'JP', 'SG', 'BR', 'ZA']) {
            expect(PINS[code], `no pin for ${code}`).toHaveLength(2);
        }
    });
});

describe('placeDestinations', () => {
    const project = (lonLat: Pt) => lonLat;

    it('sorts every destination into placed, local or unplaced, never dropping one', () => {
        const dests = [
            dest({ dest_host: 'own', location_state: 'local' }),
            dest({ dest_host: 'exact', location_state: 'outside', lat: 43.65, lon: -79.38, country_code: 'CA' }),
            dest({ dest_host: 'country', location_state: 'eu', country_code: 'FR' }),
            dest({ dest_host: 'stdio', location_state: 'unknown', location_basis: 'child_process' }),
            dest({ dest_host: 'unseen', location_state: 'unknown' }),
            dest({ dest_host: 'nowhere', location_state: 'outside' }),
        ];
        const p = placeDestinations(dests, PINS, project);
        expect(p.local.map(d => d.host)).toEqual(['own']);
        expect(p.placed.map(d => [d.host, d.exact])).toEqual([['exact', true], ['country', false]]);
        expect(p.placed[0].xy).toEqual([-79.38, 43.65]);
        expect(p.placed[1].xy).toEqual(PINS.FR);
        expect(p.unplaced.map(d => [d.host, d.reason])).toEqual([
            ['stdio', 'child_process'], ['unseen', 'none'], ['nowhere', 'no_coordinates'],
        ]);
    });

    it('never places an unknown destination, even one that carries coordinates', () => {
        const p = placeDestinations([dest({ location_state: 'unknown', location_basis: 'proxy', lat: 40, lon: -3 })], PINS, project);
        expect(p.placed).toHaveLength(0);
        expect(p.unplaced[0].reason).toBe('proxy');
    });
});

describe('the opening view', () => {
    const SIZES: Size[] = [{ w: 640, h: 320 }, { w: 1200, h: 440 }, { w: 360, h: 280 }];

    /** Everything the view must show, in screen space after the fit. */
    function frame(size: Size, targets: Array<{ host: string; lonLat: Pt }>, origin: Pt | null = NL) {
        const projection = worldProjection(size);
        const project = (ll: Pt) => projection(ll) as Pt;
        const dests = targets.map(tg => dest({ dest_host: tg.host, location_state: 'outside', lon: tg.lonLat[0], lat: tg.lonLat[1] }));
        const { placed } = placeDestinations(dests, PINS, project);
        const o = origin ? project(origin) : null;
        const arcs = buildArcs(o, placed);
        const bounds = trafficBounds(o, placed, arcs);
        const extent = unionBox(worldBox(projection), bounds);
        const t = fitTransform(bounds, size, { extent });
        return { t, arcs, placed, o };
    }

    const inside = (p: Pt, size: Size) => p[0] >= 0 && p[0] <= size.w && p[1] >= 0 && p[1] <= size.h;
    /** Points along a quadratic curve. */
    const curve = (a: Pt, c: Pt, b: Pt): Pt[] => Array.from({ length: 21 }, (_, i) => {
        const s = i / 20;
        const u = 1 - s;
        return [u * u * a[0] + 2 * u * s * c[0] + s * s * b[0], u * u * a[1] + 2 * u * s * c[1] + s * s * b[1]];
    });

    it('shows the whole line to Canada and to New Zealand, control points included', () => {
        for (const size of SIZES) {
            const { t, arcs } = frame(size, [
                { host: 'canada', lonLat: [-96.4, 60.5] },
                { host: 'nz', lonLat: [173, -41.5] },
            ]);
            expect(arcs).toHaveLength(2);
            for (const arc of arcs) {
                for (const p of [arc.from, arc.ctrl, arc.to, ...curve(arc.from, arc.ctrl, arc.to)]) {
                    expect(inside(applyZoom(p, t), size), `${arc.host} leaves the ${size.w}x${size.h} card at ${p}`).toBe(true);
                }
            }
        }
    });

    it('starts on Europe when all the traffic is European', () => {
        const size = { w: 640, h: 320 };
        const { t, placed, o } = frame(size, [
            { host: 'fra', lonLat: [8.68, 50.11] },
            { host: 'sto', lonLat: [18.07, 59.33] },
            { host: 'dub', lonLat: [-6.26, 53.35] },
        ]);
        expect(t.k).toBeGreaterThan(3);
        for (const p of [o as Pt, ...placed.map(d => d.xy)]) expect(inside(applyZoom(p, t), size)).toBe(true);
    });

    it('draws no lines without an origin, and still frames the pins', () => {
        const size = { w: 640, h: 320 };
        const { t, arcs, placed } = frame(size, [{ host: 'tor', lonLat: [-79.38, 43.65] }, { host: 'fra', lonLat: [8.68, 50.11] }], null);
        expect(arcs).toEqual([]);
        for (const d of placed) expect(inside(applyZoom(d.xy, t), size)).toBe(true);
    });

    it('shows the whole world when there is nothing to frame', () => {
        expect(fitTransform(null, { w: 640, h: 320 })).toEqual({ k: 1, x: 0, y: 0 });
    });
});

describe('style', () => {
    it('colours every line by its region, dashes outside Europe and dots a global network', () => {
        expect(lineStyle({ state: 'outside' })).toEqual({ colour: REGION_FILL.outside, dash: 'dashed', animated: true });
        expect(lineStyle({ state: 'eu' })).toEqual({ colour: REGION_FILL.eu, dash: 'solid', animated: false });
        expect(lineStyle({ state: 'local' })).toEqual({ colour: REGION_FILL.local, dash: 'solid', animated: false });
        // The edge of a network is not "outside Europe": its own colour, and dotted, not dashed.
        expect(lineStyle({ state: 'via_network' })).toEqual({ colour: REGION_FILL.via_network, dash: 'dotted', animated: false });
        expect(lineStyle({ state: 'via_network' }).colour).not.toBe(lineStyle({ state: 'outside' }).colour);
    });

    it('sizes a pin by its calls, and never lets a busy organisation draw a giant one', () => {
        expect(pinRadius(0, 50)).toBe(3.5);
        expect(pinRadius(1, 50)).toBe(5.3);
        expect(pinRadius(49, 50)).toBe(13.1);
        // 5,000 calls unscaled would be a 96px disc; the busiest is capped at the size of 100 calls.
        expect(pinRadius(5000, 5000)).toBe(pinRadius(PIN_REF_CALLS, PIN_REF_CALLS));
        expect(pinRadius(5000, 5000)).toBe(17);
        expect(pinRadius(50, 5000)).toBeLessThan(pinRadius(500, 5000));
    });

    it('widens a line with its call count, on a log scale, within bounds', () => {
        expect(lineWidth(1, 1000)).toBeLessThan(lineWidth(30, 1000));
        expect(lineWidth(30, 1000)).toBeLessThan(lineWidth(1000, 1000));
        expect(lineWidth(1000, 1000)).toBe(4.5);
        expect(lineWidth(0, 0)).toBe(1.25);
        // Log, not linear: 30 of 1000 calls is already about half the width.
        expect(lineWidth(30, 1000)).toBeGreaterThan(2.5);
    });

    it('tints the countries that received data, and not the edge of a global network', () => {
        const project = (ll: Pt) => ll;
        const { placed } = placeDestinations([
            dest({ dest_host: 'a', location_state: 'outside', country_code: 'CA' }),
            dest({ dest_host: 'b', location_state: 'eu', country_code: 'DE' }),
            dest({ dest_host: 'c', location_state: 'via_network', country_code: 'NL', lat: 52.31, lon: 4.76 }),
        ], PINS, project);
        const received = receivedByCountry(placed);
        expect([...received.entries()].sort()).toEqual([['CA', 'outside'], ['DE', 'eu']]);
        expect(countryFill('CA', 'outside')).toContain('--kind-skill');
        expect(countryFill('DE', 'eu')).not.toBe(countryFill('NL', undefined));
        expect(countryFill('NL', undefined)).toContain('--type-trigger');
        expect(countryFill('US', undefined)).toBe('var(--bg-tertiary)');
    });
});
