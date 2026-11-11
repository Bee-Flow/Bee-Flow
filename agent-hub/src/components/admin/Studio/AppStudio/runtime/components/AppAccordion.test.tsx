import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderInRuntime } from '@/test/appRuntimeRender';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import AppAccordion, { initiallyOpen } from './AppAccordion';

const kid = (id: string) => ({ id, type: 'container', visible: true, props: {}, children: [{ id: `${id}_inner`, type: 'text', props: {} }] });

function view(props: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
    const node = {
        id: 'cmp_acc', type: 'accordion', visible: true, style: { span: 12 },
        props: { items: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }], ...props },
        children: [kid('cmp_a'), kid('cmp_b'), kid('cmp_c')],
    };
    return renderInRuntime(
        <AppAccordion node={node as never}><p>Body A</p><p>Body B</p><p>Body C</p></AppAccordion>,
        { mode: 'run', ...overrides },
    );
}

const expanded = (getByRole: (role: string, opts: { name: string }) => HTMLElement, name: string) => getByRole('button', { name }).getAttribute('aria-expanded');

describe('initiallyOpen', () => {
    it('opens the first item unless an item says otherwise', () => {
        expect(initiallyOpen([{ title: 'a' }, { title: 'b' }])).toEqual([0]);
        expect(initiallyOpen([{ title: 'a' }, { title: 'b', open: true }])).toEqual([1]);
        expect(initiallyOpen([{ title: 'a', open: false }, { title: 'b' }])).toEqual([]);
        expect(initiallyOpen([])).toEqual([]);
    });
});

describe('AppAccordion', () => {
    it('shows the first item open and the others closed, with the button pattern', () => {
        const { getByRole, container } = view();
        expect(expanded(getByRole, 'One')).toBe('true');
        expect(expanded(getByRole, 'Two')).toBe('false');
        const button = getByRole('button', { name: 'One' });
        const panel = container.querySelector(`#${button.getAttribute('aria-controls')}`)!;
        expect(panel.getAttribute('role')).toBe('region');
        expect(panel.getAttribute('aria-labelledby')).toBe(button.id);
        expect(panel.hasAttribute('hidden')).toBe(false);
        expect(container.querySelectorAll('[role="heading"]')).toHaveLength(3);
    });

    it('keeps every body mounted and hides the closed ones', () => {
        const { getByText } = view();
        expect(getByText('Body A').closest('[role="region"]')!.hasAttribute('hidden')).toBe(false);
        expect(getByText('Body B').closest('[role="region"]')!.hasAttribute('hidden')).toBe(true);
    });

    it('opens one at a time with the keyboard, and closes the open one again', async () => {
        const { getByRole } = view();
        const user = userEvent.setup();
        getByRole('button', { name: 'Two' }).focus();
        await user.keyboard('{Enter}');
        expect([expanded(getByRole, 'One'), expanded(getByRole, 'Two')]).toEqual(['false', 'true']);
        await user.keyboard(' ');
        expect(expanded(getByRole, 'Two')).toBe('false');
    });

    it('lets several stay open with multiple', async () => {
        const { getByRole } = view({ multiple: true });
        const user = userEvent.setup();
        await user.click(getByRole('button', { name: 'Three' }));
        expect([expanded(getByRole, 'One'), expanded(getByRole, 'Three')]).toEqual(['true', 'true']);
    });

    it('follows the items marked open', () => {
        const { getByRole } = view({ items: [{ title: 'One' }, { title: 'Two', open: true }, { title: 'Three' }] });
        expect([expanded(getByRole, 'One'), expanded(getByRole, 'Two')]).toEqual(['false', 'true']);
    });

    it('names an item without a title, and draws a body without an item', () => {
        const { getByRole } = view({ items: [{ title: 'One' }] });
        expect(getByRole('button', { name: 'Section 2' })).toBeTruthy();
        expect(getByRole('button', { name: 'Section 3' })).toBeTruthy();
    });

    it('opens the item that holds the node selected in the editor', () => {
        const { getByRole } = view({}, { mode: 'edit', selectedNodeId: 'cmp_c_inner' });
        expect(expanded(getByRole, 'Three')).toBe('true');
    });

    it('says what to do when it has no items and no children', () => {
        const node = { id: 'cmp_acc', type: 'accordion', visible: true, style: {}, props: { items: [] } };
        const { container } = renderInRuntime(<AppAccordion node={node as never} />, { mode: 'run' });
        expect(container.textContent).toBe('Add items to this accordion.');
    });

    it('renders exactly the parts its spec declares', () => {
        const { container } = view();
        expect(renderedParts('accordion', container)).toEqual(declaredParts('accordion'));
    });
});
