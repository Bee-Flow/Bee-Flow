import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType, ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import snapshot from '../catalogSnapshot.generated.json';
import { DataProvider } from '../DataContext';
import { DEFAULT_RUNTIME, RuntimeProvider, buildScope } from '../RuntimeContext';
import AppApprovalList from './AppApprovalList';
import AppCalendar from './AppCalendar';
import AppChart from './AppChart';
import AppDataGrid from './AppDataGrid';
import AppKanban from './AppKanban';
import AppList from './AppList';
import AppPivot from './AppPivot';
import AppRepeater from './AppRepeater';
import AppTable from './AppTable';
import AppTimeline from './AppTimeline';

/**
 * Part classes of the list and analysis family (table, data_grid, list, repeater, kanban,
 * calendar, timeline, chart, pivot, approval_list): every part a type declares in its spec
 * (`parts`, carried into the catalogue snapshot) renders as `bfa-<type>__<part>`, and nothing
 * else starting with `bfa-` renders. The DOM regression gate drops these tokens, so adding them
 * is invisible to every stored app; this file is what keeps the declared list honest.
 */

type PartsComponent = ComponentType<{ node: never; children?: ReactNode }>;
type Node = Record<string, unknown>;
type Scenario = { node: Node; runtime?: Record<string, unknown>; after?: () => Promise<void> };

const staticRows = (value: unknown[]) => ({ kind: 'static', value });
const ROWS = [
    { id: 'r1', name: 'Zoe', score: 30, status: 'open', owner: 'Ann', stamp: '2026-01-10T10:00:00Z', note: 'first' },
    { id: 'r2', name: 'Amy', score: 10, status: 'done', owner: 'Bob', stamp: '2026-01-10T11:00:00Z', note: 'second' },
    { id: 'r3', name: 'Max', score: 20, status: 'open', owner: 'Ann', stamp: '2026-01-10T12:00:00Z', note: 'third' },
];
const node = (type: string, props: Node, extra: Node = {}): Node => ({ id: `cmp_${type}`, type, visible: true, props, style: { span: 12 }, ...extra });

const APPROVAL = {
    id: 'apr_1', status: 'pending', prompt: 'Approve the quote?', automationTitle: 'Quote portal',
    createdAt: '2026-01-10T10:00:00Z', expiresAt: null, fields: null, attachments: null, detailsMd: null,
};

const SCENARIOS: Record<string, { Component: PartsComponent; scenarios: Scenario[] }> = {
    table: {
        Component: AppTable as never,
        scenarios: [{
            node: node('table', {
                source: staticRows(ROWS), rowLimit: 2,
                columns: [{ key: 'name', label: 'Name' }, { key: 'score', label: 'Score', format: 'number' }],
            }),
        }],
    },
    list: {
        Component: AppList as never,
        scenarios: [{
            node: node('list', {
                source: staticRows(ROWS), titleKey: 'name', subtitleKey: 'owner', metaKey: 'note', badgeKey: 'status',
                icon: 'star', groupKey: 'owner',
            }),
        }],
    },
    approval_list: {
        Component: AppApprovalList as never,
        scenarios: [
            { node: node('approval_list', { scope: 'mine', show: 'waiting', limit: 10, showDetails: true }), runtime: { mode: 'edit' } },
            {
                node: node('approval_list', { scope: 'mine', show: 'waiting', limit: 10, showDetails: true }),
                runtime: { mode: 'run', currentUser: { id: 'u1', name: 'Sam' } },
                after: async () => {
                    await userEvent.click(await screen.findByTestId('approval-list-row'));
                    await waitFor(() => expect(document.querySelector('.bfa-approval_list__detail')).toBeTruthy());
                },
            },
        ],
    },
    data_grid: {
        Component: AppDataGrid as never,
        scenarios: [{
            node: node('data_grid', {
                source: staticRows(ROWS), pageSize: 2, selectable: 'none', searchable: true, rowActions: [], density: 'comfortable',
                columns: [{ key: 'name', label: 'Name', format: 'text' }, { key: 'score', label: 'Score', format: 'number' }],
            }),
            runtime: { mode: 'run' },
        }],
    },
    chart: {
        Component: AppChart as never,
        scenarios: [{
            node: node('chart', {
                chartType: 'bar', source: staticRows([{ label: 'Jan', open: 5 }, { label: 'Feb', open: 8 }]), title: 'Requests',
                xKey: 'label', series: [{ key: 'open', label: 'Open' }],
            }, { style: { span: 6, height: 'md' } }),
        }],
    },
    pivot: {
        Component: AppPivot as never,
        scenarios: [{
            node: node('pivot', {
                // 61 distinct column values: one more than the pivot draws, so its footnote shows.
                source: staticRows(Array.from({ length: 61 }, (_, i) => ({ region: i % 2 ? 'EU' : 'US', product: `P${i}`, amount: i }))),
                rows: [{ key: 'region', label: 'Region' }], columns: [{ key: 'product', label: 'Product' }],
                values: [{ key: 'amount', agg: 'sum', label: 'Amount', format: 'number' }], showTotals: true,
            }),
        }],
    },
    kanban: {
        Component: AppKanban as never,
        scenarios: [{
            node: node('kanban', {
                source: staticRows(ROWS), groupByField: 'status', swimlaneField: 'owner', titleKey: 'name', subtitleKey: 'owner',
                columns: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }],
            }),
        }, {
            node: node('kanban', {
                source: staticRows(ROWS), groupByField: 'status', titleKey: 'name', badgeKey: 'status',
                columns: [{ value: 'open', label: 'Open' }, { value: 'done', label: 'Done' }],
            }),
        }],
    },
    calendar: {
        Component: AppCalendar as never,
        scenarios: [{
            node: node('calendar', {
                source: staticRows(Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, title: `Event ${i}`, due: '2026-01-10' }))),
                dateKey: 'due', titleKey: 'title', view: 'month',
            }),
            runtime: { scope: buildScope({ now: '2026-01-15T00:00:00.000Z' }) },
        }, {
            node: node('calendar', { source: staticRows([{ id: 'e1', title: 'Event', due: '2026-01-10' }]), dateKey: 'due', titleKey: 'title', view: 'list' }),
            runtime: { scope: buildScope({ now: '2026-01-15T00:00:00.000Z' }) },
        }],
    },
    timeline: {
        Component: AppTimeline as never,
        scenarios: [{
            node: node('timeline', { source: staticRows(ROWS), titleKey: 'name', dateKey: 'stamp', descriptionKey: 'note', metaKey: 'owner', icon: 'star' }),
        }],
    },
    repeater: {
        Component: AppRepeater as never,
        scenarios: [{
            node: node('repeater', { source: staticRows(ROWS), itemActions: [{ actionId: 'act_1', label: 'Open' }] }, { children: [{ id: 'c1' }] }),
        }],
    },
};

const declaredParts = (type: string): string[] => (snapshot.types as unknown as Record<string, { parts?: string[] }>)[type]?.parts ?? [];

/** The `bfa-` tokens in a rendered tree, however deep and wherever (a portal included). */
function partTokens(root: ParentNode): Set<string> {
    const found = new Set<string>();
    root.querySelectorAll('[class]').forEach((el) => {
        for (const token of (el.getAttribute('class') || '').split(' ')) if (token.startsWith('bfa-')) found.add(token);
    });
    return found;
}

function mount(Component: PartsComponent, scenario: Scenario): { tree: ReactElement; value: Record<string, unknown> } {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-15T00:00:00.000Z' }), mode: 'run', ...scenario.runtime };
    const tree = (
        <RuntimeProvider value={value as never}>
            <DataProvider appId="app_7">
                <Component node={scenario.node as never}>{null}</Component>
            </DataProvider>
        </RuntimeProvider>
    );
    return { tree, value };
}

// The approval list reads through the session fetch; a stubbed global answers it, no module is mocked.
beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const detail = String(url).split('?')[0].endsWith('/approvals/apr_1');
        const body = detail ? { approval: APPROVAL, canDecide: true } : { approvals: [APPROVAL], nextCursor: null };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('part classes of the list and analysis family', () => {
    for (const [type, { Component, scenarios }] of Object.entries(SCENARIOS)) {
        it(`${type}: renders exactly the parts its spec declares`, async () => {
            const declared = declaredParts(type);
            expect(declared.length, `${type} declares no parts`).toBeGreaterThanOrEqual(3);
            expect(declared.length).toBeLessThanOrEqual(8);
            expect(new Set(declared).size).toBe(declared.length);
            expect(declared[0]).toBe('root');
            const seen = new Set<string>();
            for (const scenario of scenarios) {
                const { tree } = mount(Component, scenario);
                const { unmount } = render(tree);
                if (scenario.after) await scenario.after();
                partTokens(document.body).forEach((token) => seen.add(token));
                unmount();
            }
            const expected = declared.map((part) => `bfa-${type}__${part}`).sort();
            expect([...seen].sort()).toEqual(expected);
        });
    }

    it('covers every type the family claims, and each is a base spec type', () => {
        for (const type of Object.keys(SCENARIOS)) expect(Object.keys(snapshot.types)).toContain(type);
    });

    it('no product stylesheet refers to a bfa- part class', () => {
        const srcRoot = join(__dirname, '..', '..', '..', '..', '..', '..');
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const full = join(dir, name);
                if (statSync(full).isDirectory()) { if (name !== 'node_modules') walk(full); continue; }
                if (name.endsWith('.css') && readFileSync(full, 'utf8').includes('bfa-')) hits.push(full);
            }
        };
        walk(srcRoot);
        expect(hits).toEqual([]);
    });
});
