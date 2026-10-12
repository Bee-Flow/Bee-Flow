import { describe, it, expect } from 'vitest';

import {
    destinationsFromRows, normaliseEgressRows, normaliseGuardRows,
} from './shieldRows';

const WIN = { start: '2026-09-01T00:00:00Z', end: '2026-09-11T00:00:00Z', buckets: 10 };
const placeLabel = (row) => (row.automation_id ? `Automation — ${row.agent_name}` : 'Direct chat');

describe('normaliseGuardRows', () => {
    it('flattens a guardrail event onto the filter axes', () => {
        const [r] = normaliseGuardRows([{
            id: 7, timestamp: '2026-09-05T12:00:00Z', user_id: 'u1', display_name: 'Tom Smit',
            violation_categories: 'Email,Person', action_taken: 'tokenized', source: 'direct_chat',
        }], { placeLabel, window: WIN });

        expect(r).toMatchObject({
            id: '7', source: 'guard', person: 'u1', personLabel: 'Tom Smit',
            place: 'Direct chat', kinds: ['Email', 'Person'], action: 'tokenized', bucket: 4,
        });
        // A guard event has no destination, so a destination filter must exclude it.
        expect(r.dest).toBeNull();
    });

    it('dedupes the repeated labels legacy rows carry', () => {
        // Older rows repeat a label once per occurrence. Left alone, "Person
        // Name, Person Name, Person Name" would give that category triple
        // weight in the top-5 list.
        const [r] = normaliseGuardRows([
            { id: 1, violation_categories: 'Person Name, Person Name, Email' },
        ], { placeLabel });
        expect(r.kinds).toEqual(['Person Name', 'Email']);
    });

    it('keeps audit markers as filterable kinds', () => {
        // "Show me everything sent while the scanner was down" is a real
        // question, and `passed_unredacted` rows are the only answer to it.
        const [r] = normaliseGuardRows([
            { id: 1, violation_categories: 'privacy_protection_unavailable' },
        ], { placeLabel });
        expect(r.kinds).toEqual(['privacy_protection_unavailable']);
    });

    it('survives a row with no categories at all', () => {
        const [r] = normaliseGuardRows([{ id: 1, violation_categories: null }], { placeLabel });
        expect(r.kinds).toEqual([]);
    });

    it('returns an empty list for missing input rather than throwing', () => {
        expect(normaliseGuardRows(null, { placeLabel })).toEqual([]);
    });
});

describe('normaliseEgressRows', () => {
    it('flattens an egress row and resolves the destination', () => {
        const [r] = normaliseEgressRows([{
            id: 3, timestamp: '2026-09-05T12:00:00Z', user_id: 'u1', display_name: 'Tom Smit',
            dest_host: 'gmail.googleapis.com', country_name: 'United States', operator: 'Google LLC',
            pii_categories_detected: 'Email,Person', is_eu: false, is_local: false,
        }], { placeLabel, window: WIN });

        expect(r).toMatchObject({
            id: '3', source: 'egress', dest: 'gmail.googleapis.com', country: 'United States',
            operator: 'Google LLC', kinds: ['Email', 'Person'], isEu: false, isLocal: false, bucket: 4,
        });
    });

    it('falls back through the destination fields in order', () => {
        const pick = (row) => normaliseEgressRows([{ id: 1, ...row }], { placeLabel })[0].dest;
        expect(pick({ dest_host: 'a', tls_servername: 'b', server_endpoint: 'c' })).toBe('a');
        expect(pick({ tls_servername: 'b', server_endpoint: 'c' })).toBe('b');
        expect(pick({ server_endpoint: 'c' })).toBe('c');
        expect(pick({})).toBe('');
    });

    it('accepts categories already delivered as an array', () => {
        const [r] = normaliseEgressRows([
            { id: 1, pii_categories_detected: ['Email', 'Email', 'Person'] },
        ], { placeLabel });
        expect(r.kinds).toEqual(['Email', 'Person']);
    });

    it('carries the location the server measured', () => {
        const [r] = normaliseEgressRows([{
            id: 1, dest_host: 'api.fireflies.ai', location_state: 'via_network', location_basis: 'edge_header',
            city: 'Amsterdam', lat: 52.31, lon: 4.76, edge_pop: 'ams', network: 'Cloudflare', as_org: 'Cloudflare, Inc.',
            country_code: 'nl', country_name: 'Netherlands', peer_ip: '104.18.24.82', is_eu: false, is_local: false,
        }], { placeLabel });
        expect(r).toMatchObject({
            state: 'via_network', basis: 'edge_header', city: 'Amsterdam', lat: 52.31, lon: 4.76, edgePop: 'AMS',
            network: 'Cloudflare', asOrg: 'Cloudflare, Inc.', countryCode: 'NL', peerIp: '104.18.24.82',
            // Through a global network is neither "stayed in Europe" nor "left it".
            isEu: false, isLocal: false,
        });
    });

    it('derives the state of a row written before the location columns', () => {
        const state = (row) => normaliseEgressRows([{ id: 1, ...row }], { placeLabel })[0].state;
        expect(state({ is_local: true, is_eu: true, country_code: 'NL' })).toBe('local');
        expect(state({ is_eu: true, country_code: 'DE' })).toBe('eu');
        expect(state({ is_eu: false, country_code: 'US' })).toBe('outside');
        // No country and not local: unknown, NOT "outside Europe". Counting
        // these as outside is how a Nextcloud on a private IP read as a transfer.
        expect(state({ is_eu: false, is_local: false })).toBe('unknown');
    });
});

describe('destinationsFromRows', () => {
    const rows = normaliseEgressRows([
        { id: 1, timestamp: '2026-09-05T10:00:00Z', dest_host: 'a.example', location_state: 'outside', city: 'Toronto', lat: 43.65, lon: -79.38, country_code: 'CA', pii_categories_detected: 'Email' },
        { id: 2, timestamp: '2026-09-06T10:00:00Z', dest_host: 'a.example', location_state: 'outside', city: 'Toronto', lat: 43.65, lon: -79.38, country_code: 'CA' },
        { id: 3, timestamp: '2026-09-04T10:00:00Z', dest_host: 'a.example', location_state: 'outside', city: 'Montreal', lat: 45.5, lon: -73.57, country_code: 'CA' },
        { id: 4, timestamp: '2026-09-05T10:00:00Z', dest_host: 'b.example', location_state: 'eu', city: 'Frankfurt am Main', lat: 50.11, lon: 8.68, country_code: 'DE' },
    ], { placeLabel });

    it('gives each host ONE location: its most frequent one, whole', () => {
        const [a] = destinationsFromRows(rows);
        // Toronto twice, Montreal once: Toronto, with Toronto's coordinates.
        // Taking the most common value per column could pair one city with
        // another city's coordinates.
        expect(a).toMatchObject({ dest_host: 'a.example', total: 3, pii_events: 1, city: 'Toronto', lat: 43.65, lon: -79.38, location_state: 'outside' });
        expect(a.last_contact).toBe('2026-09-06T10:00:00Z');
    });

    it('orders by calls and honours the limit', () => {
        expect(destinationsFromRows(rows).map(d => d.dest_host)).toEqual(['a.example', 'b.example']);
        expect(destinationsFromRows(rows, 1)).toHaveLength(1);
        expect(destinationsFromRows([])).toEqual([]);
    });
});
