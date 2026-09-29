import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, collectDataBindings, dataCacheKey } from './appRuntimeHeadless';

/**
 * The headless mount is the server screenshot pipeline's ONLY window into the
 * runtime, so what these tests pin is the contract itself: a real definition +
 * a pre-resolved dataState renders the real components, and NOTHING goes over
 * the wire while it happens.
 */

const ORDERS_BINDING = { kind: 'records', tableId: 'orders' };

function makeDefinition() {
    return {
        homeScreenId: 'scr_home',
        theme: { primary: '#0F766E', appearance: 'light' },
        screens: [
            {
                id: 'scr_home',
                name: 'Overview',
                maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_main',
                        children: [
                            {
                                id: 'nd_title',
                                type: 'heading',
                                props: { text: 'Orders overview', level: 2 },
                                style: { span: 12 },
                            },
                            {
                                id: 'nd_intro',
                                type: 'text',
                                props: { text: 'All open orders at a glance.', muted: true },
                                style: { span: 12 },
                            },
                            {
                                id: 'nd_table',
                                type: 'table',
                                props: {
                                    source: ORDERS_BINDING,
                                    columns: [
                                        { key: 'customer', label: 'Customer', format: 'text' },
                                        { key: 'total', label: 'Total', format: 'number' },
                                    ],
                                    emptyText: 'Nothing to show yet.',
                                },
                                style: { span: 12 },
                            },
                            {
                                id: 'nd_cta',
                                type: 'button',
                                props: { label: 'New order', variant: 'primary' },
                                actionId: 'act_missing',
                                style: { span: 3 },
                            },
                        ],
                    },
                ],
            },
        ],
    };
}

/** dataState exactly as DataContext would hold it after a successful fetch. */
function makeDataState(rows) {
    return {
        [dataCacheKey(ORDERS_BINDING)]: {
            status: 'success',
            result: rows,
            error: null,
            tableId: 'orders',
            datasetId: null,
            connectorId: null,
        },
    };
}

describe('appRuntimeHeadless mount', () => {
    let container;
    let fetchSpy;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        // The whole point of the headless runtime: dataState in, zero fetches out.
        fetchSpy = vi.fn(() => Promise.reject(new Error('network use is forbidden in headless render')));
        vi.stubGlobal('fetch', fetchSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        container.remove();
    });

    it('renders the real components from a definition with supplied dataState', async () => {
        const rows = [
            { id: 'r1', customer: 'Acme BV', total: 1200 },
            { id: 'r2', customer: 'Globex', total: 340 },
        ];
        const handle = await mount(container, {
            definition: makeDefinition(),
            screenId: 'scr_home',
            dataState: makeDataState(rows),
            currentUser: { id: 'u1', name: 'Tom', email: 'tom@example.com', roleKey: 'owner' },
            previewRole: null,
        });

        // The screen root, in run mode, with the theme stamped.
        const screenEl = container.querySelector('[data-app-screen="scr_home"]');
        expect(screenEl).toBeTruthy();
        expect(screenEl.getAttribute('data-app-appearance')).toBe('light');
        expect(screenEl.style.getPropertyValue('--app-primary')).toBe('#0F766E');

        // Every authored node came out as its real component.
        expect(container.querySelector('[data-node-id="nd_title"]')).toBeTruthy();
        expect(container.textContent).toContain('Orders overview');
        expect(container.textContent).toContain('All open orders at a glance.');
        expect(container.querySelector('[data-node-id="nd_cta"] button, [data-node-id="nd_cta"] [role="button"]')).toBeTruthy();

        // The table resolved its records binding from the SUPPLIED dataState —
        // real rows on screen, not a skeleton and not the empty state.
        const tableCell = container.querySelector('[data-node-id="nd_table"]');
        expect(tableCell.textContent).toContain('Acme BV');
        expect(tableCell.textContent).toContain('Globex');
        expect(tableCell.textContent).not.toContain('Nothing to show yet.');

        expect(fetchSpy).not.toHaveBeenCalled();

        handle.unmount();
        expect(container.querySelector('[data-app-screen="scr_home"]')).toBeNull();
    });

    it('renders the empty state for an empty result, and a skeleton (never a fetch) for a missing entry', async () => {
        await mount(container, {
            definition: makeDefinition(),
            screenId: 'scr_home',
            dataState: makeDataState([]),
        });
        const tableCell = container.querySelector('[data-node-id="nd_table"]');
        expect(tableCell).toBeTruthy();
        expect(tableCell.textContent).toContain('Nothing to show yet.');

        // No entry at all = the binding still "loading" — the runtime shows a
        // skeleton and never fetches. Pinned because the render service must
        // therefore supply an entry for EVERY binding, empty results included,
        // or the screenshot shows placeholder shimmer instead of the screen.
        const bare = document.createElement('div');
        document.body.appendChild(bare);
        await mount(bare, { definition: makeDefinition(), screenId: 'scr_home', dataState: {} });
        expect(bare.querySelector('[data-node-id="nd_table"]')).toBeTruthy();
        expect(bare.querySelector('[data-node-id="nd_table"]').textContent).not.toContain('Acme BV');
        bare.remove();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('keeps actions inert — clicking a button fires nothing', async () => {
        await mount(container, {
            definition: makeDefinition(),
            screenId: 'scr_home',
            dataState: makeDataState([]),
        });

        const button = container.querySelector('[data-node-id="nd_cta"] button');
        expect(button).toBeTruthy();
        button.click();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('seeds vars from variable defaults so server-computed keys match (filter formulas)', async () => {
        // The render service resolves filter formulas against SEEDED variable
        // defaults before keying dataState. The mounted runtime must land on
        // the same key, which only happens if mount() seeds vars the same way
        // a live run does — an unseeded scope resolves `vars.status` to
        // undefined, drops the filter, and misses the entry forever.
        const definition = makeDefinition();
        definition.variables = [{ name: 'status', type: 'text', default: 'open' }];
        const screen = definition.screens[0];
        screen.sections[0].children[2].props.source = {
            kind: 'records',
            tableId: 'orders',
            filter: [{ field: 'status', op: 'eq', value: { kind: 'formula', expr: 'vars.status' } }],
        };
        // The key exactly as the server computes it: filter resolved to the
        // literal default before hashing.
        const serverKey = dataCacheKey({
            kind: 'records',
            tableId: 'orders',
            filter: [{ field: 'status', op: 'eq', value: 'open' }],
        });
        await mount(container, {
            definition,
            screenId: 'scr_home',
            dataState: {
                [serverKey]: {
                    status: 'success',
                    result: [{ id: 'r1', customer: 'Acme BV', total: 1200 }],
                    error: null,
                    tableId: 'orders',
                    datasetId: null,
                    connectorId: null,
                },
            },
        });
        const tableCell = container.querySelector('[data-node-id="nd_table"]');
        expect(tableCell.textContent).toContain('Acme BV');
        expect(tableCell.textContent).not.toContain('Nothing to show yet.');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('exports the dataState keying helpers the render service builds against', () => {
        const bindings = collectDataBindings(makeDefinition(), 'scr_home');
        expect(bindings).toHaveLength(1);
        expect(bindings[0].cacheKey).toBe(dataCacheKey(ORDERS_BINDING));
    });
});
