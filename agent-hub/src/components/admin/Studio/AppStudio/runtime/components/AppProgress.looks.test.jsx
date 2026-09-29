import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppProgress from './AppProgress';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * AppProgress — the look pass (props.look, spec componentSpecs.js).
 * 'bar' (or absent/unknown) is the identity: the exact pre-look bar. 'slim' is
 * the 2px quiet bar; 'ring' is the dependency-free SVG gauge with the caption
 * centered. (The pre-look bar behaviour is pinned in v21Static.test.jsx —
 * this file only owns the look additions, so parallel work on that shared
 * file stays conflict-free.)
 */

function withRuntime(ui) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const progressNode = (props = {}, style = {}) => ({
    id: 'cmp_prg', type: 'progress', visible: true,
    props: {
        value: { kind: 'static', value: 45 }, max: 100,
        format: 'percent', label: 'Done', tone: 'primary', ...props,
    },
    style: { span: 6, ...style },
});

describe('AppProgress looks', () => {
    it("look 'bar' (default) renders the identity — pinned track classes, no look attr, no svg", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ look: 'bar' })} />);
        const root = container.querySelector('[data-app-progress]');
        expect(root.getAttribute('data-app-progress-look')).toBeNull();
        const track = container.querySelector('[role="progressbar"]');
        expect(track.className).toBe('w-full h-2 rounded-full overflow-hidden');
        expect(container.querySelector('svg')).toBeNull();
        expect(track.firstChild.style.width).toBe('45%');
    });

    it('an absent look renders the identity too (stored definitions)', () => {
        const { container } = withRuntime(<AppProgress node={progressNode()} />);
        expect(container.querySelector('[data-app-progress]').getAttribute('data-app-progress-look')).toBeNull();
        expect(container.querySelector('[role="progressbar"]').className).toBe('w-full h-2 rounded-full overflow-hidden');
    });

    it('an unknown look value falls back to the identity render', () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ look: 'donut' })} />);
        expect(container.querySelector('[role="progressbar"]').className).toBe('w-full h-2 rounded-full overflow-hidden');
        expect(container.querySelector('svg')).toBeNull();
    });

    it("the size knob still drives the identity track height (lg → h-3)", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({}, { size: 'lg' })} />);
        expect(container.querySelector('[role="progressbar"]').className).toBe('w-full h-3 rounded-full overflow-hidden');
    });

    it("look 'slim' renders a 2px track, keeps caption + clamping", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ look: 'slim' })} />);
        const root = container.querySelector('[data-app-progress]');
        expect(root.getAttribute('data-app-progress-look')).toBe('slim');
        const track = container.querySelector('[role="progressbar"]');
        expect(track.className).toBe('w-full rounded-full overflow-hidden');
        expect(track.style.height).toBe('2px');
        expect(track.firstChild.style.width).toBe('45%');
        expect(container.querySelector('[data-app-progress-caption]').textContent).toBe('45%');
    });

    it("look 'ring' renders an SVG gauge with the caption centered and a11y intact", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ look: 'ring' })} />);
        const root = container.querySelector('[data-app-progress]');
        expect(root.getAttribute('data-app-progress-look')).toBe('ring');
        const gauge = container.querySelector('[role="progressbar"]');
        expect(gauge.getAttribute('aria-valuenow')).toBe('45');
        expect(gauge.getAttribute('aria-valuemax')).toBe('100');
        expect(gauge.getAttribute('aria-label')).toBe('Done');
        expect(container.querySelectorAll('svg circle').length).toBe(2);
        expect(container.querySelector('[data-app-progress-caption]').textContent).toBe('45%');
        expect(container.textContent).toContain('Done');
    });

    it("ring honours the size knob and clamps like the bar", () => {
        const { container } = withRuntime(
            <AppProgress node={progressNode({ look: 'ring', value: { kind: 'static', value: 12 }, max: 10, format: 'fraction' }, { size: 'lg' })} />,
        );
        const svg = container.querySelector('svg');
        expect(svg.getAttribute('width')).toBe('88');
        expect(container.querySelector('[role="progressbar"]').getAttribute('aria-valuenow')).toBe('10');
        expect(container.querySelector('[data-app-progress-caption]').textContent).toBe('10 / 10');
    });

    it("ring with format 'none' shows no center caption but still the gauge", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ look: 'ring', format: 'none' })} />);
        expect(container.querySelector('svg')).toBeTruthy();
        expect(container.querySelector('[data-app-progress-caption]')).toBeNull();
    });

    it('emits no purple/indigo/violet in any look', () => {
        for (const look of ['slim', 'ring']) {
            const { container } = withRuntime(<AppProgress node={progressNode({ look })} />);
            expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML), look).toBe(false);
        }
    });
});
