import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppProgress from './AppProgress';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * progress.segments (spec: server/appStudio/componentSpecs.js) — the stacked
 * distribution bar. An empty list is the identity path (the single value/max
 * bar, pinned in AppProgress.looks.test.jsx / v21Static.test.jsx); non-empty
 * replaces the fill with side-by-side segments whose widths normalize on the
 * sum. Works for looks 'bar' and 'slim'; 'ring' ignores segments.
 */

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const progressNode = (props = {}, style = {}) => ({
    id: 'cmp_prg', type: 'progress', visible: true,
    props: {
        value: { kind: 'static', value: 45 }, max: 100,
        format: 'percent', label: 'Rijen', tone: 'primary', ...props,
    },
    style: { span: 6, ...style },
});

const SEGMENTS = [
    { value: { kind: 'static', value: 2 }, tone: 'danger', label: 'Onvolledig' },
    { value: { kind: 'static', value: 3 }, tone: 'warning', label: 'Controleren' },
    { value: { kind: 'static', value: 5 }, tone: 'success', label: 'OK' },
];

describe('AppProgress — segments', () => {
    it('an empty segments list keeps the identity single bar', () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ segments: [] })} />);
        expect(container.querySelector('[data-app-progress-segments]')).toBeNull();
        const track = container.querySelector('[role="progressbar"]');
        expect(track.className).toBe('w-full h-2 rounded-full overflow-hidden');
        expect(track.firstChild.style.width).toBe('45%');
        expect(container.querySelector('[data-app-progress-caption]').textContent).toBe('45%');
    });

    it('renders one segment per entry, widths normalized on the sum', () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ segments: SEGMENTS })} />);
        const root = container.querySelector('[data-app-progress]');
        expect(root.getAttribute('data-app-progress-segments')).toBe('3');
        const parts = container.querySelectorAll('[data-app-progress-segment]');
        expect(parts.length).toBe(3);
        expect(parts[0].style.width).toBe('20%');
        expect(parts[1].style.width).toBe('30%');
        expect(parts[2].style.width).toBe('50%');
        expect(parts[0].getAttribute('data-app-progress-segment')).toBe('danger');
        expect(parts[1].getAttribute('data-app-progress-segment')).toBe('warning');
        expect(parts[2].getAttribute('data-app-progress-segment')).toBe('success');
        // The labels ride on the segment tooltips.
        expect(parts[0].getAttribute('title')).toBe('Onvolledig: 2');
    });

    it('keeps the progressbar role and aria bounds on the track', () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ segments: SEGMENTS })} />);
        const track = container.querySelector('[role="progressbar"]');
        expect(track.getAttribute('aria-valuemin')).toBe('0');
        expect(track.getAttribute('aria-valuemax')).toBe('10');
        expect(track.getAttribute('aria-label')).toBe('Rijen');
        // The single-bar caption describes value/max, which segments replace.
        expect(container.querySelector('[data-app-progress-caption]')).toBeNull();
        expect(container.textContent).toContain('Rijen');
    });

    it('a zero (or unresolvable) sum renders an empty track, never NaN widths', () => {
        const segments = [
            { value: { kind: 'static', value: 0 }, tone: 'danger' },
            { value: { kind: 'formula', expr: '' }, tone: 'success' },
        ];
        const { container } = withRuntime(<AppProgress node={progressNode({ segments })} />);
        const track = container.querySelector('[role="progressbar"]');
        expect(track).toBeTruthy();
        expect(container.querySelectorAll('[data-app-progress-segment]').length).toBe(0);
    });

    it('negative and non-numeric values count as 0 and drop out of the bar', () => {
        const segments = [
            { value: { kind: 'static', value: -4 }, tone: 'danger' },
            { value: { kind: 'static', value: 'nope' }, tone: 'warning' },
            { value: { kind: 'static', value: 4 }, tone: 'success' },
        ];
        const { container } = withRuntime(<AppProgress node={progressNode({ segments })} />);
        const parts = container.querySelectorAll('[data-app-progress-segment]');
        expect(parts.length).toBe(1);
        expect(parts[0].style.width).toBe('100%');
    });

    it("look 'slim' keeps its 2px track under the segments", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ segments: SEGMENTS, look: 'slim' })} />);
        const root = container.querySelector('[data-app-progress]');
        expect(root.getAttribute('data-app-progress-look')).toBe('slim');
        const track = container.querySelector('[role="progressbar"]');
        expect(track.style.height).toBe('2px');
        expect(container.querySelectorAll('[data-app-progress-segment]').length).toBe(3);
    });

    it("look 'ring' ignores segments and stays the single-value gauge", () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ segments: SEGMENTS, look: 'ring' })} />);
        expect(container.querySelector('svg')).toBeTruthy();
        expect(container.querySelectorAll('[data-app-progress-segment]').length).toBe(0);
    });

    it('segment values may come from the runtime scope', () => {
        const segments = [
            { value: { kind: 'formula', expr: 'vars.bad' }, tone: 'danger' },
            { value: { kind: 'formula', expr: 'vars.good' }, tone: 'success' },
        ];
        const { container } = withRuntime(
            <AppProgress node={progressNode({ segments })} />,
            { scope: buildScope({ vars: { bad: 1, good: 3 }, now: '2026-01-01T00:00:00.000Z' }) },
        );
        const parts = container.querySelectorAll('[data-app-progress-segment]');
        expect(parts[0].style.width).toBe('25%');
        expect(parts[1].style.width).toBe('75%');
    });

    it('emits no purple/indigo/violet', () => {
        const { container } = withRuntime(<AppProgress node={progressNode({ segments: SEGMENTS })} />);
        expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML)).toBe(false);
    });
});
