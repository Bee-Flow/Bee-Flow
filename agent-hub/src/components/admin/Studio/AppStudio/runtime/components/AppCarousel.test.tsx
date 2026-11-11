import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderInRuntime } from '@/test/appRuntimeRender';
import { declaredParts, renderedParts } from '@/test/appPartsRendered';
import AppCarousel from './AppCarousel';

const kid = (id: string) => ({ id, type: 'container', visible: true, props: {}, children: [{ id: `${id}_inner`, type: 'text', props: {} }] });

function view(props: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}, slides = 3) {
    const ids = ['cmp_a', 'cmp_b', 'cmp_c'].slice(0, slides);
    const node = { id: 'cmp_car', type: 'carousel', visible: true, style: { span: 12 }, props, children: ids.map(kid) };
    return {
        user: userEvent.setup(),
        ...renderInRuntime(
            <AppCarousel node={node as never}>{ids.map((id, i) => <p key={id}>Slide body {i + 1}</p>)}</AppCarousel>,
            { mode: 'run', ...overrides },
        ),
    };
}

const showing = (container: HTMLElement) => [...container.querySelectorAll('[aria-roledescription="slide"]')].map((s) => !s.hasAttribute('hidden'));

describe('AppCarousel', () => {
    it('is a labelled carousel region that shows the first slide', () => {
        const { getByRole, container } = view();
        expect(getByRole('region', { name: 'Carousel' }).getAttribute('aria-roledescription')).toBe('carousel');
        expect(showing(container)).toEqual([true, false, false]);
        const slide = container.querySelector('[aria-roledescription="slide"]')!;
        expect(slide.getAttribute('role')).toBe('group');
        expect(slide.getAttribute('aria-label')).toBe('Slide 1 of 3');
    });

    it('moves with labelled previous and next buttons, and stops at the ends', async () => {
        const { getByRole, container, user } = view();
        const previous = getByRole('button', { name: 'Previous slide' }) as HTMLButtonElement;
        const next = getByRole('button', { name: 'Next slide' }) as HTMLButtonElement;
        expect(previous.disabled).toBe(true);
        await user.click(next);
        expect(showing(container)).toEqual([false, true, false]);
        await user.click(next);
        expect(showing(container)).toEqual([false, false, true]);
        expect(next.disabled).toBe(true);
        await user.click(previous);
        expect(showing(container)).toEqual([false, true, false]);
    });

    it('wraps around with loop', async () => {
        const { getByRole, container, user } = view({ loop: true });
        await user.click(getByRole('button', { name: 'Previous slide' }));
        expect(showing(container)).toEqual([false, false, true]);
        await user.click(getByRole('button', { name: 'Next slide' }));
        expect(showing(container)).toEqual([true, false, false]);
    });

    it('goes to a slide from its dot, which is marked current, and works from the keyboard', async () => {
        const { getByRole, container, user } = view();
        getByRole('button', { name: 'Go to slide 3' }).focus();
        await user.keyboard('{Enter}');
        expect(showing(container)).toEqual([false, false, true]);
        expect(getByRole('button', { name: 'Go to slide 3' }).getAttribute('aria-current')).toBe('true');
        expect(getByRole('button', { name: 'Go to slide 1' }).hasAttribute('aria-current')).toBe(false);
    });

    it('hides the dots with showDots off, and the buttons with a single slide', () => {
        const noDots = view({ showDots: false });
        expect(noDots.queryByRole('button', { name: 'Go to slide 1' })).toBeNull();
        noDots.unmount();
        const single = view({}, {}, 1);
        expect(single.queryByRole('button', { name: 'Next slide' })).toBeNull();
        expect(showing(single.container)).toEqual([true]);
    });

    it('keeps every slide mounted', () => {
        const { getByText } = view();
        expect(getByText('Slide body 3').closest('[aria-roledescription="slide"]')!.hasAttribute('hidden')).toBe(true);
    });

    it('shows the slide that holds the node selected in the editor', () => {
        const { container } = view({}, { mode: 'edit', selectedNodeId: 'cmp_c_inner' });
        expect(showing(container)).toEqual([false, false, true]);
    });

    it('says what to do when it has no slides', () => {
        const node = { id: 'cmp_car', type: 'carousel', visible: true, style: {}, props: {} };
        const { container } = renderInRuntime(<AppCarousel node={node as never} />, { mode: 'run' });
        expect(container.textContent).toBe('Add slides to this carousel.');
    });

    it('renders exactly the parts its spec declares', () => {
        const { container } = view();
        expect(renderedParts('carousel', container)).toEqual(declaredParts('carousel'));
    });
});
