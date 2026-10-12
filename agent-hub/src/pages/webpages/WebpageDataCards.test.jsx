import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * WebpageDataCards — de middenkolom van "Data & koppelingen".
 *
 * `authFetch` is gemockt; de fixture spiegelt het contract van
 * GET /api/webpages/:id/data-cards (server: core/webpages/webpageDataCards.js).
 * Wat hier vastligt is wat het scherm mag BEWEREN: de gestippelde "niet
 * gebruikt" alleen bij een gecontroleerde false, publieke kolommen apart
 * gemarkeerd, en een mislukte lezing die niet als "er hangt niets aan" leest.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

import WebpageDataCards, { countDataCards, sharingDeepLink } from './WebpageDataCards';

const CARDS = {
    tables: [{
        datatableId: 'tbl_1', name: 'Rates', key: 'rates', rowCount: 42,
        mode: 'readwrite', columns: ['name', 'price'], publicColumns: ['name'],
        allColumns: [{ key: 'name', label: 'Product' }, { key: 'price', label: 'Price' }],
        usedInCode: true, missing: false, reason: null,
    }],
    automations: [{
        automationId: 'auto_1', title: 'Tarieven beheren', datatableId: 'tbl_1', tableName: 'Rates',
        columns: ['price'], writes: true, lastRunAt: null,
    }],
    warnings: [{
        kind: 'automation_writes_directly', automationId: 'auto_1', automationTitle: 'Tarieven beheren',
        datatableId: 'tbl_1', tableName: 'Rates',
    }],
    counts: { tables: 1, automations: 1 },
};

function response(body, ok = true, status = 200) {
    return { ok, status, json: async () => body };
}

function clone(over = {}) {
    return JSON.parse(JSON.stringify({ ...CARDS, ...over }));
}

beforeEach(() => { authFetch.mockReset(); });

describe('WebpageDataCards', () => {
    it('renders a card per table with rows, column chips and the public marker', async () => {
        authFetch.mockResolvedValue(response(clone()));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);

        expect(await screen.findByText('Rates')).toBeInTheDocument();
        expect(screen.getByText('42 rows (approximate)')).toBeInTheDocument();
        expect(screen.getByText('Read and write')).toBeInTheDocument();
        // publicColumns wordt apart gemarkeerd; een gewone kolom niet.
        expect(screen.getByText('Product · Public')).toBeInTheDocument();
        expect(screen.getByText('Price')).toBeInTheDocument();
    });

    it('BITE — "Not used on this page" appears only when usedInCode is exactly false', async () => {
        authFetch.mockResolvedValue(response(clone({ tables: [{ ...CARDS.tables[0], usedInCode: false }] })));
        const { unmount } = render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        expect(await screen.findByText('Not used on this page')).toBeInTheDocument();
        unmount();

        // null = de bestanden waren niet te lezen. Dan zwijgt het scherm.
        authFetch.mockResolvedValue(response(clone({ tables: [{ ...CARDS.tables[0], usedInCode: null }] })));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        expect(await screen.findByText('Rates')).toBeInTheDocument();
        expect(screen.queryByText('Not used on this page')).toBeNull();
    });

    it('shows the feeding automation and the warning card with a deep link to sharing', async () => {
        authFetch.mockResolvedValue(response(clone()));
        const onNavigate = vi.fn();
        render(<WebpageDataCards webpageId="wp1" sources={[]} onNavigate={onNavigate} />);

        expect(await screen.findByText(/writes straight into table Rates/)).toBeInTheDocument();
        expect(screen.getByText('Feeds Rates · never ran')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/datatables/tbl_1?tab=sharing');
    });

    it('without an in-app navigator the Set up action is still a real link', async () => {
        authFetch.mockResolvedValue(response(clone()));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        const link = await screen.findByRole('link', { name: 'Set up' });
        expect(link.getAttribute('href')).toBe('/app/studio/datatables/tbl_1?tab=sharing');
    });

    it('BITE — a failed load says so; it must never read as "nothing is linked"', async () => {
        authFetch.mockResolvedValue(response({ error: 'boom' }, false, 500));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        expect(await screen.findByText('Could not load what is linked to this page.')).toBeInTheDocument();
        expect(screen.queryByText('No table is linked to this page yet.')).toBeNull();
    });

    it('a page with no bindings says so, and still shows the knowledge card', async () => {
        authFetch.mockResolvedValue(response({ tables: [], automations: [], warnings: [], counts: { tables: 0, automations: 0 } }));
        render(<WebpageDataCards webpageId="wp1" sources={[{ id: 's1' }, { id: 's2' }]} />);
        expect(await screen.findByText('No table is linked to this page yet.')).toBeInTheDocument();
        expect(screen.getByText('Knowledge sources')).toBeInTheDocument();
        expect(screen.getByText('2 sources the assistant reads when building this page')).toBeInTheDocument();
    });

    it('a table the owner can no longer open stays on screen as unavailable', async () => {
        authFetch.mockResolvedValue(response(clone({
            tables: [{
                datatableId: 'tbl_9', missing: true, reason: 'datatable_not_found',
                mode: 'read', columns: ['name'], publicColumns: [], allColumns: [],
                name: null, rowCount: null, usedInCode: false,
            }],
            automations: [], warnings: [],
        })));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        expect(await screen.findByText('Table unavailable')).toBeInTheDocument();
        expect(screen.getByText(/still linked to tbl_9/)).toBeInTheDocument();
    });

    it('the singular row label is a different KEY, not a stitched-on "s"', async () => {
        authFetch.mockResolvedValue(response(clone({
            tables: [{ ...CARDS.tables[0], rowCount: 1 }], automations: [], warnings: [],
        })));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        expect(await screen.findByText('1 row (approximate)')).toBeInTheDocument();
    });

    it('an unknown row count says so rather than showing 0', async () => {
        authFetch.mockResolvedValue(response(clone({
            tables: [{ ...CARDS.tables[0], rowCount: null }], automations: [], warnings: [],
        })));
        render(<WebpageDataCards webpageId="wp1" sources={[]} />);
        expect(await screen.findByText('Row count unavailable')).toBeInTheDocument();
        expect(screen.queryByText('0 rows (approximate)')).toBeNull();
    });
});

describe('countDataCards', () => {
    it('counts tables + feeding automations + the one knowledge card', () => {
        expect(countDataCards(CARDS)).toBe(3);
        expect(countDataCards({ tables: [], automations: [] })).toBe(1);
    });

    it('answers 0 without data — a badge may not promise what the screen cannot show', () => {
        expect(countDataCards(null)).toBe(0);
        expect(countDataCards(undefined)).toBe(0);
    });
});

describe('sharingDeepLink', () => {
    it('points at the table and asks for its sharing tab', () => {
        expect(sharingDeepLink('tbl_1')).toBe('studio/datatables/tbl_1?tab=sharing');
    });
});
