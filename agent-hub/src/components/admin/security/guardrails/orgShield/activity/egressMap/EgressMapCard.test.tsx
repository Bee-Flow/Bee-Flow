/**
 * "Where your data went", drawn for real.
 *
 * jsdom lays nothing out (every clientWidth is 0) and the test setup's
 * ResizeObserver never fires, so the map would stay on "Drawing the map…"
 * forever and none of this could be asserted. The element size is stubbed
 * here instead, and reduced motion is switched on so every zoom lands at once
 * rather than over a 450 ms transition.
 *
 * Run: npx vitest run src/components/admin/security/guardrails/orgShield/activity/egressMap/EgressMapCard.test.tsx
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React, { useState } from 'react';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { REGION_FILL } from '../../shieldPalette';
import EgressMapCard, { type RawOrigin } from './EgressMapCard';
import type { EgressMapFilters } from './egressMapContract';
import type { RawDestination } from './mapModel';

/** The real t(key, fallback, params) contract, fallback-first. */
const t = (key: string, fallbackOrParams?: string | Record<string, unknown>, params?: Record<string, unknown>) => {
    const text = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
    const values = (typeof fallbackOrParams === 'string' ? params : fallbackOrParams) || {};
    return Object.entries(values).reduce((s, [k, v]) => s.split(`{${k}}`).join(String(v)), text);
};

const ORIGIN: RawOrigin = { country_code: 'NL', country_name: 'Netherlands', lat: 52.37, lon: 4.9, label: 'Your server' };

const DESTS: RawDestination[] = [
    { dest_host: 'cloud.example.nl', location_state: 'local', location_basis: 'socket', country_code: 'NL', total: 50, pii_events: 0 },
    {
        dest_host: 'api.claimsbridge.ca', location_state: 'outside', location_basis: 'socket', city: 'Toronto', lat: 43.65, lon: -79.38,
        country_code: 'CA', country_name: 'Canada', operator: 'ClaimsBridge Inc.', total: 42, pii_events: 7,
        sample_peer_ip: '198.51.100.24', last_contact: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    },
    {
        dest_host: 'api.openai.com', location_state: 'via_network', location_basis: 'edge_header', city: 'Amsterdam', lat: 52.31, lon: 4.76,
        edge_pop: 'AMS', network: 'Cloudflare', country_code: 'NL', operator: 'OpenAI, L.L.C.', total: 30, pii_events: 0,
    },
    {
        dest_host: 'api.dossierbank.eu', location_state: 'eu', location_basis: 'socket', city: 'Helsinki', lat: 60.17, lon: 24.94,
        country_code: 'FI', country_name: 'Finland', total: 20, pii_events: 0, sample_peer_ip: '203.0.113.40',
    },
    { dest_host: 'api.expertiseportaal.nl', location_state: 'unknown', location_basis: 'none', total: 5, pii_events: 0 },
];

const MAP = {
    attribution: { text: 'IP geolocation by DB-IP', url: 'https://db-ip.com' },
    geoDb: { available: true },
};

function Harness({ origin = ORIGIN, geoDb = MAP.geoDb, onSelect = () => {}, filters }: {
    origin?: RawOrigin | null;
    geoDb?: { available: boolean };
    onSelect?: (host: string) => void;
    filters?: EgressMapFilters;
}) {
    const [selected, setSelected] = useState<string | null>(null);
    return (
        <EgressMapCard
            mapDestinations={DESTS}
            listDestinations={DESTS}
            origin={origin}
            attribution={MAP.attribution}
            geoDb={geoDb}
            selected={selected}
            onSelect={(host) => { onSelect(host); setSelected(s => (s === host ? null : host)); }}
            filters={filters}
            t={t}
        />
    );
}

const KIND_LABELS: Record<string, string> = {
    Person: 'Person names', Email: 'Email addresses', Company: 'Company names',
    Phone: 'Phone numbers', Address: 'Home addresses', IBAN: 'IBAN numbers',
};

/** What the pane hands the card: see egressMapContract.ts. */
const filtersWith = (over: Partial<EgressMapFilters> = {}): EgressMapFilters => ({
    selectedKind: null,
    onSelectKind: vi.fn(),
    selectedRegion: null,
    onSelectRegion: vi.fn(),
    kindCounts: Object.entries({ Person: 50, Email: 40, Company: 25, Phone: 22, Address: 20, IBAN: 10 })
        .map(([id, n]) => ({ id, label: KIND_LABELS[id], n })),
    hostKinds: { 'api.claimsbridge.ca': [['Email', 5], ['Person', 2]] },
    hostTypes: { 'api.claimsbridge.ca': 'tool', 'api.openai.com': 'web_search' },
    regionTotals: { local: 50, eu: 20, outside: 42, via_network: 30, unknown: 5 },
    catLabel: (id: string) => KIND_LABELS[id] || id,
    ...over,
});

const restore: Array<() => void> = [];
beforeAll(() => {
    for (const [prop, value] of [['clientWidth', 800], ['clientHeight', 400]] as const) {
        const before = Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop);
        Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get: () => value });
        restore.push(() => { if (before) Object.defineProperty(HTMLElement.prototype, prop, before); });
    }
    const matchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query, onchange: null,
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
        dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    restore.push(() => { window.matchMedia = matchMedia; });
});
afterAll(() => { for (const undo of restore) undo(); });

const pin = (name: RegExp) => screen.findByRole('button', { name });
const countries = (c: HTMLElement) => c.querySelector('svg > g')?.getAttribute('transform') || '';

describe('EgressMapCard: pins, tooltip and selection', () => {
    it('draws a pin per placed destination, and lists the one it cannot place with its reason', async () => {
        render(<Harness />);
        expect(await pin(/^api\.claimsbridge\.ca, Toronto, Canada: 42 calls$/)).toBeInTheDocument();
        expect(await pin(/^api\.openai\.com, Cloudflare edge, Amsterdam: 30 calls$/)).toBeInTheDocument();
        expect(await pin(/^api\.dossierbank\.eu, Helsinki, Finland: 20 calls$/)).toBeInTheDocument();
        // Your own server sits at the origin: no pin of its own.
        expect(screen.queryByRole('button', { name: /^cloud\.example\.nl,/ })).toBeNull();
        expect(screen.getByText('Location unknown')).toBeInTheDocument();
        expect(screen.getByText('No connection was seen')).toBeInTheDocument();
    });

    it('shows where, who, how much and HOW WE KNOW on hover', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        await user.hover(await pin(/^api\.claimsbridge\.ca,/));
        const tip = screen.getByRole('tooltip');
        expect(tip).toHaveTextContent('Toronto, Canada');
        expect(tip).toHaveTextContent('ClaimsBridge Inc.');
        expect(tip).toHaveTextContent('42 calls · 7 with personal data');
        expect(tip).toHaveTextContent('Seen on the connection to 198.51.100.24');

        await user.hover(await pin(/^api\.openai\.com,/));
        expect(screen.getByRole('tooltip')).toHaveTextContent('Cloudflare reported its edge (AMS); the service behind it is not visible');
    });

    it('shows the tooltip and a focus ring to a keyboard user', async () => {
        const user = userEvent.setup();
        const { container } = render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        await user.tab();
        const focused = document.activeElement as Element;
        expect(focused.getAttribute('role')).toBe('button');
        expect(screen.getByRole('tooltip')).toBeInTheDocument();
        expect(focused.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
        expect(container.querySelector('circle[stroke-dasharray="3 2"]')).not.toBeNull();
    });

    it('filters on a destination when its pin is clicked, and Escape clears it', async () => {
        const onSelect = vi.fn();
        const user = userEvent.setup();
        render(<Harness onSelect={onSelect} />);
        const canada = await pin(/^api\.claimsbridge\.ca,/);
        await user.click(canada);
        expect(onSelect).toHaveBeenCalledWith('api.claimsbridge.ca');
        expect(canada).toHaveAttribute('aria-pressed', 'true');

        await user.keyboard('{Escape}');
        expect(onSelect).toHaveBeenCalledTimes(2);
        expect(canada).toHaveAttribute('aria-pressed', 'false');
    });

});

describe('EgressMapCard: controls, list and footnote', () => {
    it('has the four map buttons, and each one moves the view', async () => {
        const user = userEvent.setup();
        const { container } = render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        const home = countries(container);

        await user.click(screen.getByRole('button', { name: 'Zoom in' }));
        const zoomed = countries(container);
        expect(zoomed).not.toBe(home);

        await user.click(screen.getByRole('button', { name: 'Zoom out' }));
        expect(countries(container)).not.toBe(zoomed);

        await user.click(screen.getByRole('button', { name: 'Whole world' }));
        expect(countries(container)).toMatch(/scale\(1\)$/);

        await user.click(screen.getByRole('button', { name: 'Fit to traffic' }));
        expect(countries(container)).toBe(home);
    });

    it('shares one hover between the list and the map', async () => {
        const user = userEvent.setup();
        render(<Harness />);
        const row = screen.getByRole('button', { name: 'Filter on api.claimsbridge.ca' });
        await pin(/^api\.claimsbridge\.ca,/);

        await user.hover(row);
        expect(screen.getByRole('tooltip')).toHaveTextContent('api.claimsbridge.ca');
        await user.unhover(row);
        expect(screen.queryByRole('tooltip')).toBeNull();

        await user.hover(await pin(/^api\.claimsbridge\.ca,/));
        expect(row).toHaveAttribute('data-lit', 'true');
    });

    it('credits the geolocation database only when it is the one in use', async () => {
        const { rerender } = render(<Harness />);
        const link = await screen.findByRole('link', { name: 'IP geolocation by DB-IP' });
        expect(link).toHaveAttribute('href', 'https://db-ip.com');
        rerender(<Harness geoDb={{ available: false }} />);
        expect(screen.queryByRole('link', { name: 'IP geolocation by DB-IP' })).toBeNull();
    });

    it('without a server location: pins, no lines, and a hint for the admin', async () => {
        const { container } = render(<Harness origin={null} />);
        expect(await pin(/^api\.claimsbridge\.ca,/)).toBeInTheDocument();
        expect(screen.getByText(/BEEFLOW_SERVER_LOCATION/)).toBeInTheDocument();
        expect(container.querySelectorAll('path[data-map-hit]')).toHaveLength(0);
    });

    it('draws a line to each place with a known location, and none to its own city', async () => {
        const { container } = render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        // Toronto and Helsinki; the Amsterdam edge sits on the origin.
        expect(container.querySelectorAll('path[data-map-hit]')).toHaveLength(2);
    });

    it('leaves a plain scroll wheel to the page, and says how to zoom', async () => {
        const { container } = render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        const before = countries(container);
        // userEvent has no wheel; this is the one event it cannot replace.
        fireEvent.wheel(container.querySelector('svg') as SVGSVGElement, { deltaY: 120 });
        await waitFor(() => expect(screen.getByText(/and scroll to zoom/)).toBeInTheDocument());
        expect(countries(container)).toBe(before);
    });

    it('says in its corner how to move and zoom, naming the key', async () => {
        render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        expect(screen.getByText('Drag to move · Ctrl + scroll or +/− to zoom')).toBeInTheDocument();
        expect(screen.getByRole('list', { name: 'Map legend' }))
            .toHaveTextContent(/Your server.*Inside Europe.*Outside Europe.*Via a global network/);
    });
});

describe('EgressMapCard: the list under the map', () => {
    it('groups the destinations by region, with the reason for one it cannot place', async () => {
        render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        const groups = screen.getAllByRole('group').filter(g => g.tagName === 'DIV' && g.getAttribute('aria-label'));
        expect(groups.map(g => g.getAttribute('aria-label'))).toEqual([
            'Map controls',
            // The same words as the filter chip a header click creates.
            'Your own server', 'Inside Europe (EEA)', 'Outside Europe', 'Via a global network', 'Location unknown',
        ]);
        // A global network: how the edge was seen, never who runs the service behind it.
        expect(screen.getByRole('button', { name: 'Filter on api.openai.com' }))
            .toHaveTextContent('Cloudflare reported its edge (AMS); the service behind it is not visible');
        expect(screen.getByRole('button', { name: 'Filter on api.expertiseportaal.nl' })).toHaveTextContent('No connection was seen');
        // Without the pane's filters a group header is a heading, not a filter.
        expect(screen.queryByRole('button', { name: /^Outside Europe/ })).toBeNull();
    });

    it('shows each row with its place, its calls and how many carried personal data', async () => {
        render(<Harness />);
        const row = await screen.findByRole('button', { name: 'Filter on api.claimsbridge.ca' });
        expect(row).toHaveTextContent('Toronto, Canada · ClaimsBridge Inc.');
        expect(row).toHaveTextContent('7 pd');
        expect(row).toHaveTextContent(/42$/);
    });

    it('with the pane\'s filters: counts per region, and a header filters on its region', async () => {
        const filters = filtersWith({ selectedRegion: 'eu' });
        const user = userEvent.setup();
        render(<Harness filters={filters} />);
        const outside = await screen.findByRole('button', { name: /^Outside Europe/ });
        expect(outside).toHaveTextContent('42 calls · 29%');
        expect(outside).toHaveAttribute('aria-pressed', 'false');
        expect(screen.getByRole('button', { name: /^Inside Europe/ })).toHaveAttribute('aria-pressed', 'true');
        await user.click(outside);
        expect(filters.onSelectRegion).toHaveBeenCalledWith('outside');
    });

    it('names the kind of call only for a destination the fetched calls say something about', async () => {
        render(<Harness filters={filtersWith()} />);
        expect(await screen.findByRole('button', { name: 'Filter on api.claimsbridge.ca' })).toHaveTextContent('Tool');
        expect(screen.getByRole('button', { name: 'Filter on api.openai.com' })).toHaveTextContent('Web search');
        expect(screen.getByRole('button', { name: 'Filter on api.dossierbank.eu' })).not.toHaveTextContent('Tool');
    });
});

describe('EgressMapCard: the kind filter on the map', () => {
    const dot = (el: HTMLElement) => el.querySelector('circle[stroke-width="2"]')?.getAttribute('fill');

    it('offers All data, the four kinds found most, and the rest in a menu', async () => {
        const filters = filtersWith();
        const user = userEvent.setup();
        render(<Harness filters={filters} />);
        await pin(/^api\.claimsbridge\.ca,/);
        const bar = screen.getByRole('group', { name: 'Kinds of data' });
        const pills = within(bar).getAllByRole('button');
        expect(pills.map(b => b.textContent)).toEqual(['All data', 'Person names50', 'Email addresses40', 'Company names25', 'Phone numbers22']);
        expect(pills[0]).toHaveAttribute('aria-pressed', 'true');

        const more = within(bar).getByRole('combobox', { name: 'More kinds of data' });
        expect(within(more).getAllByRole('option').map(o => o.textContent)).toEqual(['+2 more', 'Home addresses (20)', 'IBAN numbers (10)']);

        await user.click(pills[2]);
        expect(filters.onSelectKind).toHaveBeenLastCalledWith('Email');
        await user.selectOptions(more, 'IBAN');
        expect(filters.onSelectKind).toHaveBeenLastCalledWith('IBAN');
        await user.click(pills[0]);
        expect(filters.onSelectKind).toHaveBeenLastCalledWith(null);
    });

    it('keeps the kind that is on as a pill, even when it is not among the four', async () => {
        render(<Harness filters={filtersWith({ selectedKind: 'IBAN' })} />);
        const bar = await screen.findByRole('group', { name: 'Kinds of data' });
        expect(within(bar).getByRole('button', { name: /IBAN numbers/ })).toHaveAttribute('aria-pressed', 'true');
        expect(within(bar).getByRole('button', { name: 'All data' })).toHaveAttribute('aria-pressed', 'false');
        expect(within(bar).getAllByRole('option').map(o => o.textContent)).toEqual(['+1 more', 'Home addresses (20)']);
    });

    it('greys a pin, and drops its line, when the kind that is on never went there', async () => {
        const { container } = render(<Harness filters={filtersWith({ selectedKind: 'Email' })} />);
        expect(dot(await pin(/^api\.claimsbridge\.ca,/))).toBe(REGION_FILL.outside);
        expect(dot(await pin(/^api\.dossierbank\.eu,/))).toBe('var(--text-tertiary)');
        expect(container.querySelectorAll('path[data-map-hit]')).toHaveLength(1);
    });

    it('colours every pin by its region without a kind filter', async () => {
        render(<Harness filters={filtersWith()} />);
        expect(dot(await pin(/^api\.claimsbridge\.ca,/))).toBe(REGION_FILL.outside);
        expect(dot(await pin(/^api\.dossierbank\.eu,/))).toBe(REGION_FILL.eu);
        expect(dot(await pin(/^api\.openai\.com,/))).toBe(REGION_FILL.via_network);
    });

    it('labels a busy pin with its host and what went there', async () => {
        const { container } = render(<Harness filters={filtersWith()} />);
        await pin(/^api\.claimsbridge\.ca,/);
        const labels = container.querySelector('svg g[aria-hidden="true"]');
        expect(labels).toHaveTextContent('api.claimsbridge.ca');
        expect(labels).toHaveTextContent('Email addresses +1 more');
    });

    it('lists the kinds in the tooltip, and says they come from the most recent calls', async () => {
        const user = userEvent.setup();
        render(<Harness filters={filtersWith()} />);
        await user.hover(await pin(/^api\.claimsbridge\.ca,/));
        const tip = screen.getByRole('tooltip');
        expect(tip).toHaveTextContent('Kinds of data, in the most recent calls');
        expect(tip).toHaveTextContent(/Email addresses\s*5/);
        expect(tip).toHaveTextContent(/Person names\s*2/);
        // Still there under the kinds.
        expect(tip).toHaveTextContent('Seen on the connection to 198.51.100.24');
    });

    it('shows no kind pills without the pane\'s filters', async () => {
        render(<Harness />);
        await pin(/^api\.claimsbridge\.ca,/);
        expect(screen.queryByRole('group', { name: 'Kinds of data' })).toBeNull();
    });
});

