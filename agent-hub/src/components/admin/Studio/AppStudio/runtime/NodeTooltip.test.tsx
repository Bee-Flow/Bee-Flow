import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen, screenApp } from '@/test/appScreenRender';
import TooltipField, { setNodeTooltip } from '../inspector/TooltipField';
import type { AppNode } from '../inspector/appDefinition';

const button = { id: 'cmp_btn', type: 'button', visible: true, props: { label: 'Recalculate' }, style: { span: 4 }, tooltip: 'Runs the totals again' };
const text = { id: 'cmp_txt', type: 'text', visible: true, props: { text: 'VAT' }, style: { span: 4 }, tooltip: 'Value added tax <b>21%</b>' };

describe('tooltip key (schema 3)', () => {
    it('describes the control inside, starts hidden and shows on focus until Escape', async () => {
        const { getByRole, user } = renderScreen([button]);
        const control = getByRole('button', { name: 'Recalculate' });
        const tip = document.getElementById(control.getAttribute('aria-describedby') as string) as HTMLElement;
        expect(tip.getAttribute('role')).toBe('tooltip');
        expect(tip.textContent).toBe('Runs the totals again');
        expect(tip.hidden).toBe(true);
        await user.tab();
        expect(control).toBe(document.activeElement);
        expect(tip.hidden).toBe(false);
        await user.keyboard('{Escape}');
        expect(tip.hidden).toBe(true);
    });

    it('makes a component without a control focusable, writes the text as text, and shows on hover', async () => {
        const { getByText, user, container } = renderScreen([text]);
        const anchor = container.querySelector('.bfa-tooltip__anchor') as HTMLElement;
        expect(anchor.tabIndex).toBe(0);
        const tip = document.getElementById(anchor.getAttribute('aria-describedby') as string) as HTMLElement;
        expect(tip.textContent).toBe('Value added tax <b>21%</b>');
        expect(tip.querySelector('b')).toBeNull();
        await user.hover(getByText('VAT'));
        expect(tip.hidden).toBe(false);
    });

    it('a node without a tooltip has no wrapper', () => {
        const { container } = renderScreen([{ ...button, tooltip: undefined }]);
        expect(container.querySelector('.bfa-tooltip__anchor')).toBeNull();
    });

    it('the inspector field sets and removes the key', () => {
        const def = screenApp([button]);
        const nodeOf = (d: typeof def) => (d.screens as { sections: { children: AppNode[] }[] }[])[0].sections[0].children[0];
        expect(nodeOf(setNodeTooltip(def, 'cmp_btn', 'New text')).tooltip).toBe('New text');
        expect('tooltip' in nodeOf(setNodeTooltip(def, 'cmp_btn', '  '))).toBe(false);
        const { getByDisplayValue } = render(<TooltipField definition={def} node={nodeOf(def)} onCommit={vi.fn()} disabled={false} />);
        expect(getByDisplayValue('Runs the totals again')).toBeTruthy();
    });
});
