import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/test/appScreenRender';

const ROWS = [{ id: 'r1', title: 'First', owner: 'Ann', status: 'todo' }, { id: 'r2', title: 'Second', owner: 'Bob', status: 'todo' }];
const source = { kind: 'static', value: ROWS };

/** A text node that writes `expr` with the row in scope. */
const line = (id: string, expr: string) => ({ id, type: 'text', visible: true, props: { text: '' }, computed: { text: expr }, style: { span: 12 } });

describe('item templates (schema 3)', () => {
    it('a list without children draws its built-in rows', () => {
        const { container, getByText } = renderScreen([{ id: 'cmp_list', type: 'list', visible: true, props: { source, titleKey: 'title' }, style: { span: 12 } }]);
        expect(getByText('First')).toBeTruthy();
        expect(container.querySelector('[data-app-item-template]')).toBeNull();
    });

    it('a list draws its children once per row with item and index in scope', () => {
        const node = {
            id: 'cmp_list', type: 'list', visible: true, props: { source, titleKey: 'title' }, style: { span: 12 },
            children: [line('cmp_l1', 'concat(index + 1, ". ", item.title, " by ", item.owner)')],
        };
        const { container, getByText, queryByText } = renderScreen([node]);
        expect(getByText('1. First by Ann')).toBeTruthy();
        expect(getByText('2. Second by Bob')).toBeTruthy();
        expect(queryByText('First')).toBeNull();
        expect(container.querySelectorAll('.bfa-list__template')).toHaveLength(2);
    });

    it('a clickable template row runs the row action, but not for a click on a control inside it', async () => {
        const runAction = vi.fn();
        const node = {
            id: 'cmp_list', type: 'list', visible: true, props: { source }, style: { span: 12 }, onRowClick: 'act_open',
            children: [line('cmp_l1', 'item.title'), { id: 'cmp_b1', type: 'button', visible: true, props: { label: 'Own' }, onClick: 'act_own', style: { span: 12 } }],
        };
        const { getAllByRole, getByText, user } = renderScreen([node], { runAction }, { act_open: { kind: 'toast', message: 'x' }, act_own: { kind: 'toast', message: 'y' } });
        await user.click(getByText('Second'));
        expect(runAction).toHaveBeenLastCalledWith('act_open', expect.objectContaining({ item: ROWS[1] }));
        runAction.mockClear();
        await user.click(getAllByRole('button', { name: 'Own' })[0]);
        expect(runAction.mock.calls.map((c) => c[0])).toEqual(['act_own']);
        const row = getAllByRole('button').find((el) => el.getAttribute('tabindex') === '0') as HTMLElement;
        row.focus();
        await user.keyboard('{Enter}');
        expect(runAction).toHaveBeenLastCalledWith('act_open', expect.objectContaining({ item: ROWS[0] }));
    });

    it('a kanban draws its children per card', () => {
        const node = {
            id: 'cmp_kan', type: 'kanban', visible: true, style: { span: 12 },
            props: { source, groupByField: 'status', columns: [{ value: 'todo', label: 'To do' }], allowDrag: false },
            children: [line('cmp_k1', 'concat(item.title, " / ", item.owner)')],
        };
        const { getByText, container } = renderScreen([node]);
        expect(getByText('First / Ann')).toBeTruthy();
        expect(getByText('Second / Bob')).toBeTruthy();
        expect(container.querySelectorAll('.bfa-kanban__template')).toHaveLength(2);
    });

    it('a template column writes the formula text per row, and a dash when it answers nothing', () => {
        const node = {
            id: 'cmp_tbl', type: 'table', visible: true, style: { span: 12 },
            props: { source, columns: [{ key: 'title', format: 'template', template: 'item.title + " (" + item.owner + ")"' }, { key: 'owner', format: 'template', template: 'item.missing' }] },
        };
        const { getByText, container } = renderScreen([node]);
        expect(getByText('First (Ann)')).toBeTruthy();
        expect(container.querySelectorAll('[data-app-cell-template]')).toHaveLength(2);
        expect(container.querySelectorAll('[data-app-cell-empty]')).toHaveLength(2);
    });
});
