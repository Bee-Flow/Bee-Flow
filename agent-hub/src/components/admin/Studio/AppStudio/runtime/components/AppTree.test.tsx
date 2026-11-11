import { describe, expect, it, vi } from 'vitest';
import { partNames, renderScreen } from '@/test/appScreenRender';
import { buildTree, idOf } from './treeModel';

const ROWS = [
    { id: 'a', title: 'Europe' },
    { id: 'b', title: 'Netherlands', parent: { id: 'a', label: 'Europe' } },
    { id: 'c', title: 'Delft', parent: 'b' },
    { id: 'd', title: 'Asia' },
];

const tree = (props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    id: 'cmp_tree', type: 'tree', visible: true, style: { span: 12 },
    props: { source: { kind: 'static', value: ROWS }, parentKey: 'parent', icon: 'Folder', subtitleKey: 'id', ...props }, ...extra,
});

describe('AppTree', () => {
    it('nests rows under their parent, the top level expanded, as a tree view', () => {
        const { getByRole, queryByText, container } = renderScreen([tree()]);
        const europe = getByRole('treeitem', { name: /Europe/ });
        expect(europe.getAttribute('aria-expanded')).toBe('true');
        expect(europe.getAttribute('aria-level')).toBe('1');
        expect(getByRole('treeitem', { name: /Netherlands/ }).getAttribute('aria-expanded')).toBe('false');
        expect(queryByText('Delft')).toBeNull();
        expect(europe.tabIndex).toBe(0);
        const { rendered, declared } = partNames('tree', renderScreen([tree({ maxDepth: 1, maxNodes: 1 })]).container);
        expect([...new Set([...rendered, ...partNames('tree', container).rendered])].sort()).toEqual(declared);
    });

    it('moves with the arrow keys, opens with Right and closes with Left', async () => {
        const { getByRole, findByText, user } = renderScreen([tree()]);
        getByRole('treeitem', { name: /Europe/ }).focus();
        await user.keyboard('{ArrowDown}');
        const nl = getByRole('treeitem', { name: /Netherlands/ });
        expect(document.activeElement).toBe(nl);
        await user.keyboard('{ArrowRight}');
        expect(await findByText('Delft')).toBeTruthy();
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(getByRole('treeitem', { name: /Delft/ }));
        await user.keyboard('{ArrowLeft}');
        expect(document.activeElement).toBe(nl);
        await user.keyboard('{End}');
        expect(document.activeElement).toBe(getByRole('treeitem', { name: /Asia/ }));
    });

    it('Enter runs the row action with the row', async () => {
        const runAction = vi.fn();
        const { getByRole, user } = renderScreen([tree({}, { onRowClick: 'act_open' })], { runAction }, { act_open: { kind: 'toast', message: 'x' } });
        getByRole('treeitem', { name: /Asia/ }).focus();
        await user.keyboard('{Enter}');
        expect(runAction).toHaveBeenCalledWith('act_open', expect.objectContaining({ item: ROWS[3] }));
    });

    it('bounds depth and count, and leaves a cycle out', () => {
        const deep = buildTree(ROWS, { idKey: 'id', parentKey: 'parent', maxDepth: 2, maxNodes: 500 });
        expect(deep.roots[0].children[0].hiddenBelow).toBe(1);
        expect(buildTree(ROWS, { idKey: 'id', parentKey: 'parent', maxDepth: 6, maxNodes: 2 }).cut).toBe(2);
        const loop = buildTree([{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }, { id: 'z' }], { idKey: 'id', parentKey: 'parent', maxDepth: 6, maxNodes: 10 });
        expect(loop.roots.map((n) => n.row.id)).toEqual(['z']);
        expect(idOf([{ id: 7 }])).toBe('7');
    });
});
