import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screenApp } from '@/test/appScreenRender';
import ItemTemplateField, { setItemTemplate } from './ItemTemplateField';
import type { AppNode } from './appDefinition';

const listNode = { id: 'cmp_list', type: 'list', visible: true, props: { titleKey: 'name' }, style: { span: 12 } };
const nodeOf = (def: ReturnType<typeof screenApp>) => (def.screens as { sections: { children: AppNode[] }[] }[])[0].sections[0].children[0];

describe('ItemTemplateField', () => {
    it('switching on gives the list a starter text on the row title, switching off removes it', () => {
        const on = setItemTemplate(screenApp([listNode]), 'cmp_list', true);
        const child = nodeOf(on).children?.[0] as AppNode & { computed?: Record<string, unknown> };
        expect(child.type).toBe('text');
        expect(child.computed).toEqual({ text: { kind: 'formula', expr: 'item.name' } });
        expect('children' in nodeOf(setItemTemplate(on, 'cmp_list', false))).toBe(false);
    });

    it('shows only on a list or a kanban and commits the change', async () => {
        const onCommit = vi.fn();
        const def = screenApp([listNode]);
        const { getByRole } = render(<ItemTemplateField definition={def} node={nodeOf(def)} onCommit={onCommit} disabled={false} />);
        await userEvent.setup().click(getByRole('checkbox', { name: /design the row yourself/i }));
        expect(nodeOf(onCommit.mock.calls[0][0]).children).toHaveLength(1);
        const text = { ...listNode, type: 'text' };
        const { container } = render(<ItemTemplateField definition={def} node={text as AppNode} onCommit={onCommit} disabled={false} />);
        expect(container.innerHTML).toBe('');
    });
});
