import { describe, expect, it } from 'vitest';
import { renderScreen } from '@/test/appScreenRender';
import { repeaterItemsLayout } from './repeaterLayout';

const ROWS = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Gamma' }];

const repeater = (props: Record<string, unknown> = {}) => ({
    id: 'cmp_rep', type: 'repeater', visible: true, style: { span: 12, gap: 3, padding: 0 },
    props: { source: { kind: 'static', value: ROWS }, itemActions: [], emptyText: 'None', ...props },
    children: [{ id: 'cmp_name', type: 'text', visible: true, props: { text: 'x' }, computed: { text: 'item.name' }, style: { span: 12 } }],
});

const root = (container: HTMLElement) => container.querySelector('[data-app-repeater="true"]') as HTMLElement;

describe('repeater item layout (schema 3)', () => {
    it('a repeater without a layout keeps the stack it always had', () => {
        const plain = root(renderScreen([repeater()]).container);
        expect(plain.className).toBe('flex flex-col bfa-repeater__root');
        expect(plain.getAttribute('data-app-repeater-layout')).toBeNull();
        expect(plain.getAttribute('style')).toBe('gap: calc(12px * var(--app-space, 1));');
        expect(repeaterItemsLayout({ layout: 'stack', itemColumns: 4 }, '0px')).toBeNull();
    });

    it('grid puts the items on a column grid with a count per breakpoint', () => {
        const { container, getByText } = renderScreen([repeater({ layout: 'grid', itemColumns: 4, itemColumnsSm: 2 })]);
        const grid = root(container);
        expect(grid.getAttribute('data-app-repeater-layout')).toBe('grid');
        expect(grid.classList.contains('app-grid')).toBe(true);
        expect(grid.classList.contains('app-repeater-items--grid')).toBe(true);
        expect(grid.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
        expect(grid.style.getPropertyValue('--app-rep-cols-md')).toBe('2');
        expect(grid.style.getPropertyValue('--app-rep-cols-sm')).toBe('2');
        expect(grid.querySelectorAll(':scope > .app-repeater-item')).toHaveLength(3);
        expect(getByText('Gamma')).toBeTruthy();
    });

    it('row is one sideways line a keyboard can reach, three items in view by default', () => {
        const { container, getByRole } = renderScreen([repeater({ layout: 'row' })]);
        const row = root(container);
        expect(row.className).toBe('app-repeater-items--row bfa-repeater__root');
        expect(row.style.getPropertyValue('--app-rep-cols')).toBe('3');
        expect(row.style.getPropertyValue('--app-rep-cols-md')).toBe('2');
        expect(row.style.getPropertyValue('--app-rep-cols-sm')).toBe('1');
        expect(getByRole('region', { name: /scroll sideways/i })).toBe(row);
        expect(row.tabIndex).toBe(0);
    });

    it('an item count outside 1..6 falls back to the default', () => {
        expect(repeaterItemsLayout({ layout: 'grid', itemColumns: 9, itemColumnsMd: 0 }, '0px')?.columns).toEqual({ lg: 3, md: 2, sm: 1 });
    });
});
