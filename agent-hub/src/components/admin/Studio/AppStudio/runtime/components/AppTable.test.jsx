import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppTable from './AppTable';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

function withRuntime(ui, overrides = {}) {
    const value = {
        ...DEFAULT_RUNTIME,
        scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
        mode: 'run',
        ...overrides,
    };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const ROWS = [
    { id: 1, name: 'Zoe', score: 30 },
    { id: 2, name: 'Amy', score: 10 },
    { id: 3, name: 'Max', score: 20 },
];

function tableNode(propOverrides = {}, overrides = {}) {
    return {
        id: 'cmp_table', type: 'table', visible: true,
        props: {
            source: { kind: 'static', value: ROWS },
            columns: [
                { key: 'name', label: 'Name', format: 'text' },
                { key: 'score', label: 'Score', format: 'number' },
            ],
            emptyText: 'Nothing to show yet.', rowLimit: 25,
            ...propOverrides,
        },
        style: { span: 12 },
        ...overrides,
    };
}

describe('AppTable', () => {
    it('renders bound rows', () => {
        const { getByText } = withRuntime(<AppTable node={tableNode()} />);
        expect(getByText('Zoe')).toBeTruthy();
        expect(getByText('Amy')).toBeTruthy();
    });

    it('shows the empty state when unbound', () => {
        const { getByText } = withRuntime(
            <AppTable node={tableNode({ source: { kind: 'static', value: [] } })} />,
        );
        expect(getByText('Nothing to show yet.')).toBeTruthy();
    });
});

describe('AppTable — look variants', () => {
    /*
     * These pins guard "default == unknown == the base look, and the variants
     * are additive" — NOT the specific base. The base was deliberately
     * restyled (see the same note in AppDataGrid.test.jsx): both table
     * components now share `app-grid-base` and render through one cell module,
     * so they gained the shared rhythm together and the strings are re-pinned
     * rather than defended.
     */
    const DEFAULT_TABLE_CLS = 'w-full app-grid-base text-sm';
    const DEFAULT_TH_CLS = 'text-left font-medium px-2.5 py-1.5 border-b';
    const DEFAULT_TD_CLS = 'px-2.5 py-1.5 border-b align-middle text-left';

    const classesOf = (container) => ({
        table: container.querySelector('table').getAttribute('class'),
        th: container.querySelector('thead th').getAttribute('class'),
        td: container.querySelector('tbody td').getAttribute('class'),
    });

    it('default look renders the exact pre-look classes (no new class, no new style)', () => {
        const { container } = withRuntime(<AppTable node={tableNode()} />);
        const got = classesOf(container);
        expect(got.table).toBe(DEFAULT_TABLE_CLS);
        expect(got.th).toBe(DEFAULT_TH_CLS);
        expect(got.td).toBe(DEFAULT_TD_CLS);
    });

    it("look:'default' explicitly is identical to no look at all", () => {
        const { container } = withRuntime(<AppTable node={tableNode({ look: 'default' })} />);
        expect(classesOf(container)).toEqual({
            table: DEFAULT_TABLE_CLS, th: DEFAULT_TH_CLS, td: DEFAULT_TD_CLS,
        });
    });

    it('an unknown look value falls back to the identity path', () => {
        const { container } = withRuntime(<AppTable node={tableNode({ look: 'sparkly' })} />);
        expect(classesOf(container)).toEqual({
            table: DEFAULT_TABLE_CLS, th: DEFAULT_TH_CLS, td: DEFAULT_TD_CLS,
        });
    });

    it("look:'striped' stamps the shared zebra class and keeps the row rules", () => {
        const { container } = withRuntime(<AppTable node={tableNode({ look: 'striped' })} />);
        expect(container.querySelector('table').classList.contains('app-grid-zebra')).toBe(true);
        expect(classesOf(container).td).toContain('border-b');
    });

    it("look:'minimal' drops every divider and quiets the header", () => {
        const { container } = withRuntime(<AppTable node={tableNode({ look: 'minimal' })} />);
        const got = classesOf(container);
        expect(got.table).toBe(DEFAULT_TABLE_CLS); // no table-level class needed
        expect(got.th).not.toContain('border-b');
        expect(got.td).not.toContain('border-b');
        expect(got.th).toContain('uppercase');
        expect(got.th).toContain('tracking-wider');
        // airy padding replaces the rules as the row separator
        expect(got.td).toContain('py-2.5');
    });

    it("look:'minimal' respects size:'sm'", () => {
        const { container } = withRuntime(
            <AppTable node={tableNode({ look: 'minimal' }, { style: { span: 12, size: 'sm' } })} />,
        );
        const td = container.querySelector('tbody td').getAttribute('class');
        expect(td).toContain('px-2 py-2');
        expect(td).not.toContain('border-b');
    });

    it('introduces no hex colors in the component source', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.join(__dirname, 'AppTable.jsx'), 'utf8');
        expect(src).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
});
