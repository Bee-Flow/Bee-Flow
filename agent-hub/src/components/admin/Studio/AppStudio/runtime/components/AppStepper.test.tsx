import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AppStepper from './AppStepper';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';
import { runtimeValue } from '@/test/appRuntime';
import type { ComponentProps } from 'react';
import { stub } from '@/test/mocks';

/**
 * 'stepper' — where a record IS in its process.
 *
 * The behaviour worth pinning is the honest one: a value that matches no step
 * must leave every stage upcoming rather than implying the work has started.
 */

const STEPS = [
    { value: 'new', label: 'New', icon: null },
    { value: 'open', label: 'Open', icon: null },
    { value: 'done', label: 'Done', icon: null },
];

function node(value: unknown, extra = {}) {
    return {
        id: 'cmp_step01', type: 'stepper',
        props: {
            value: { kind: 'static', value },
            steps: STEPS, orientation: 'horizontal', tone: 'primary', showLabels: true,
            ...extra,
        },
        style: {},
    };
}

function renderStepper(n: ComponentProps<typeof AppStepper>['node'], runtime = {}) {
    const value = {
        ...DEFAULT_RUNTIME,
        scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }),
        mode: 'run',
        ...runtime,
    };
    return render(
        <RuntimeProvider value={runtimeValue(stub<Parameters<typeof runtimeValue>[0]>(value))}>
            <AppStepper node={n} />
        </RuntimeProvider>,
    );
}

describe('AppStepper', () => {
    it('marks the matching step current and the earlier ones done', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('open')));
        const items = container.querySelectorAll('[role="listitem"]');
        expect(items).toHaveLength(3);
        expect((items[0] as HTMLElement).dataset.state).toBe('done');
        expect((items[1] as HTMLElement).dataset.state).toBe('current');
        expect((items[2] as HTMLElement).dataset.state).toBe('upcoming');
        expect(screen.getByText('Open')).toBeInTheDocument();
    });

    it('leaves everything upcoming when the value matches no step', () => {
        // A record can hold a status somebody removed from the vocabulary.
        // Treating that as "step 1 in progress" would be a lie about the work.
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('archived')));
        for (const item of container.querySelectorAll('[role="listitem"]')) {
            expect((item as HTMLElement).dataset.state).toBe('upcoming');
        }
    });

    it('is inert without an event, and clickable with one', async () => {
        const user = userEvent.setup();
        const { container, unmount } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('new')));
        expect(container.querySelectorAll('button')).toHaveLength(0);
        unmount();

        const runAction = vi.fn();
        const clickable = { ...node('new'), onRowClick: 'act_pick01' };
        renderStepper(stub<Parameters<typeof renderStepper>[0]>(clickable), { runAction });
        await user.click(screen.getByText('Done').closest('button')!);
        // The step itself rides along as `item`/`value`/`index`, so a navigate
        // param can carry which step was clicked.
        expect(runAction).toHaveBeenCalledWith('act_pick01', expect.objectContaining({
            formValues: { value: 'done', label: 'Done', index: 2 },
            value: 'done',
            index: 2,
        }));
    });

    it('renders nothing without steps, rather than an empty rail', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('new', { steps: [] })));
        expect(container.querySelector('[data-app-stepper]')).toBeNull();
    });
});

/**
 * A hint per step — what this stage is waiting on, on hover or focus.
 *
 * It is a BINDING, not a caption: the sentence worth reading is "2 lines are
 * still missing a material", which is only knowable at render time. That is
 * what lets the bar absorb the status strip that used to sit under it.
 */
describe('AppStepper hints', () => {
    const withHint = (hint: string) => node('open', {
        steps: [
            { value: 'new', label: 'New' },
            { value: 'open', label: 'Open', hint: { kind: 'static', value: hint } },
            { value: 'done', label: 'Done' },
        ],
    });

    it('renders the hint as a tooltip tied to its step', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(withHint('2 regels missen materiaal.')));
        const tip = container.querySelector('.app-stepper-hint');
        expect(tip!.textContent).toBe('2 regels missen materiaal.');
        expect(tip!.getAttribute('role')).toBe('tooltip');
        // aria-describedby is what makes it reach a screen reader at all — the
        // panel is display:none until hover, so without the link it is silent.
        const item = tip!.closest('[data-has-hint]');
        expect(item!.getAttribute('aria-describedby')).toBe(tip!.id);
    });

    it('makes a hinted step reachable by keyboard when it is not a button', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(withHint('Iets om te weten.')));
        expect(container.querySelector('[data-has-hint]')!.getAttribute('tabindex')).toBe('0');
    });

    it('adds nothing at all to a step without a hint', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('open')));
        expect(container.querySelector('.app-stepper-hint')).toBeNull();
        expect(container.querySelector('[data-has-hint]')).toBeNull();
    });

    it('treats a blank hint as no hint', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(withHint('   ')));
        expect(container.querySelector('[data-has-hint]')).toBeNull();
    });
});

/**
 * The bar has to reach the right edge.
 *
 * Every step took an equal share of the row, but the LAST one carries no
 * connector — so its share sat empty and the bar stopped short, leaving a gap
 * that read as a layout bug on any wide screen.
 */
describe('AppStepper width', () => {
    it('gives the slack to the connectors, not to the final step', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('open')));
        const items = [...container.querySelectorAll('.app-stepper-item')];
        expect(items).toHaveLength(3);
        // The first two grow; the last is only as wide as its marker + label.
        expect(items[0].className).toContain('flex-1');
        expect(items[1].className).toContain('flex-1');
        expect(items[2].className).not.toContain('flex-1');
        expect(items[2].className).toContain('shrink-0');
    });

    it('leaves a vertical stepper alone — there is no row to fill', () => {
        const { container } = renderStepper(stub<Parameters<typeof renderStepper>[0]>(node('open', { orientation: 'vertical' })));
        for (const item of container.querySelectorAll('.app-stepper-item')) {
            expect(item.className).not.toContain('shrink-0');
        }
    });
});
