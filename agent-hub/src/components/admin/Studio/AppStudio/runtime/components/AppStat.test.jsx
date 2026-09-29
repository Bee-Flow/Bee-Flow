import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppStat from './AppStat';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2020-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

function statNode(props = {}) {
    return {
        id: 'cmp_stat', type: 'stat', visible: true,
        props: { label: 'Open', value: { kind: 'static', value: '42' }, caption: null, icon: null, ...props },
        style: { span: 3 },
    };
}

const FORBIDDEN = [/#6366f1/i, /#7c3aed/i, /indigo/i, /violet/i, /purple/i];

describe('AppStat', () => {
    it('renders a plain v1 tile (label + value) unchanged', () => {
        const { getByText } = withRuntime(<AppStat node={statNode()} />);
        expect(getByText('Open')).toBeTruthy();
        expect(getByText('42')).toBeTruthy();
    });

    it('renders a positive delta chip in success colour when positiveIsGood', () => {
        const node = statNode({ delta: { kind: 'static', value: 8 }, deltaFormat: 'percent', positiveIsGood: true });
        const { container, getByText } = withRuntime(<AppStat node={node} />);
        const chip = container.querySelector('[data-app-stat-delta]');
        expect(chip).toBeTruthy();
        expect(getByText('8%')).toBeTruthy();
        expect(chip.getAttribute('style')).toContain(ROLE_SUCCESS_RGB);
    });

    it('colours a positive delta as danger when positiveIsGood is false', () => {
        const node = statNode({ delta: { kind: 'static', value: 3 }, positiveIsGood: false });
        const { container } = withRuntime(<AppStat node={node} />);
        const chip = container.querySelector('[data-app-stat-delta]');
        expect(chip.getAttribute('style')).toContain(ROLE_DANGER_RGB);
    });

    it('renders a sparkline when trend resolves to a series', () => {
        const node = statNode({ trend: { kind: 'static', value: [1, 3, 2, 5, 4] } });
        const { container } = withRuntime(<AppStat node={node} />);
        expect(container.querySelector('[data-app-stat-trend]')).toBeTruthy();
        expect(container.querySelector('svg.recharts-surface')).toBeTruthy();
    });

    it('omits delta and sparkline when their bindings are null (v1 parity)', () => {
        const { container } = withRuntime(<AppStat node={statNode()} />);
        expect(container.querySelector('[data-app-stat-delta]')).toBeNull();
        expect(container.querySelector('[data-app-stat-trend]')).toBeNull();
    });

    it('never paints raw JSON when the value binding resolves to a dataset', () => {
        const rows = [{ id: 'rec_1', name: 'Hive 1' }, { id: 'rec_2', name: 'Hive 2' }];
        const { container, getByText } = withRuntime(
            <AppStat node={statNode({ value: { kind: 'static', value: rows } })} />,
        );
        expect(getByText('2 items')).toBeTruthy();
        expect(container.textContent).not.toContain('{');
    });

    it('never paints raw JSON when the value binding resolves to a record', () => {
        const { container, getByText } = withRuntime(
            <AppStat node={statNode({ value: { kind: 'static', value: { name: 'Hive 4', id: 'rec_1' } } })} />,
        );
        expect(getByText('Hive 4')).toBeTruthy();
        expect(container.textContent).not.toContain('{');
    });

    it('emits no purple/indigo/violet', () => {
        const node = statNode({ delta: { kind: 'static', value: -4 }, trend: { kind: 'static', value: [5, 3, 1] } });
        const { container } = withRuntime(<AppStat node={node} />);
        const html = container.innerHTML;
        for (const re of FORBIDDEN) expect(re.test(html)).toBe(false);
    });
});

// The look pass (props.look, spec componentSpecs.js): 'plain' is the identity —
// the exact pre-look markup — and each other value must announce itself with
// its own class so templates/builders can rely on visibly distinct stats.
describe('AppStat looks', () => {
    const IDENTITY_CLASS = 'app-stat flex items-start gap-2.5';

    it("look 'plain' (the default) stamps no look class and no style — identity", () => {
        const { container } = withRuntime(<AppStat node={statNode({ look: 'plain' })} />);
        const root = container.querySelector('.app-stat');
        expect(root.className).toBe(IDENTITY_CLASS);
        expect(root.getAttribute('style')).toBeNull();
    });

    it('an absent look renders the identity too (stored v1/v2 defs)', () => {
        const { container } = withRuntime(<AppStat node={statNode()} />);
        const root = container.querySelector('.app-stat');
        expect(root.className).toBe(IDENTITY_CLASS);
        expect(root.getAttribute('style')).toBeNull();
    });

    it('an unknown look value falls back to the identity render', () => {
        const { container } = withRuntime(<AppStat node={statNode({ look: 'bogus' })} />);
        const root = container.querySelector('.app-stat');
        expect(root.className).toBe(IDENTITY_CLASS);
        expect(root.getAttribute('style')).toBeNull();
    });

    for (const look of ['tile', 'tinted', 'accent', 'gradient']) {
        it(`look '${look}' carries its distinguishing class`, () => {
            const { container } = withRuntime(<AppStat node={statNode({ look })} />);
            const root = container.querySelector('.app-stat');
            expect(root.className).toContain(`app-stat--${look}`);
            // Label and value still render inside the surfaced tile.
            expect(root.textContent).toContain('Open');
            expect(root.textContent).toContain('42');
        });
    }

    it('no look emits purple/indigo/violet', () => {
        for (const look of ['tile', 'tinted', 'accent', 'gradient']) {
            const { container } = withRuntime(<AppStat node={statNode({ look })} />);
            const html = container.innerHTML;
            for (const re of FORBIDDEN) expect(re.test(html), `${look} vs ${re}`).toBe(false);
        }
    });
});

/**
 * captionSegments (spec: componentSpecs.js): non-empty replaces `caption`,
 * texts render VERBATIM back to back (the author owns spaces and separators),
 * each in its tone color — 'muted' being the identity grey.
 */
describe('AppStat — captionSegments', () => {
    const SEGS = [
        { text: '3 met actie nodig', tone: 'danger' },
        { text: ' · 1 nieuw vandaag', tone: 'muted' },
    ];

    it('an empty list keeps the plain caption (identity)', () => {
        const { getByText, container } = withRuntime(
            <AppStat node={statNode({ caption: 'sinds 14 aug', captionSegments: [] })} />,
        );
        expect(getByText('sinds 14 aug')).toBeTruthy();
        expect(container.querySelector('[data-app-stat-caption-segments]')).toBeNull();
    });

    it('non-empty replaces caption and renders the texts verbatim, in order', () => {
        const { container, queryByText } = withRuntime(
            <AppStat node={statNode({ caption: 'sinds 14 aug', captionSegments: SEGS })} />,
        );
        expect(queryByText('sinds 14 aug')).toBeNull();
        const line = container.querySelector('[data-app-stat-caption-segments]');
        // Exact concatenation — no separators injected between segments.
        expect(line.textContent).toBe('3 met actie nodig · 1 nieuw vandaag');
        const spans = line.querySelectorAll('span');
        expect(spans.length).toBe(2);
        expect(spans[0].getAttribute('data-app-stat-caption-tone')).toBe('danger');
        expect(spans[1].getAttribute('data-app-stat-caption-tone')).toBe('muted');
        expect(spans[1].style.color).toBe('var(--text-muted)');
    });

    it('entries without text are skipped; unknown tones read as muted', () => {
        const segs = [
            { text: '', tone: 'danger' },
            { tone: 'success' },
            { text: 'ok', tone: 'sparkly' },
        ];
        const { container } = withRuntime(<AppStat node={statNode({ captionSegments: segs })} />);
        const line = container.querySelector('[data-app-stat-caption-segments]');
        const spans = line.querySelectorAll('span');
        expect(spans.length).toBe(1);
        expect(spans[0].getAttribute('data-app-stat-caption-tone')).toBe('muted');
    });

    it('emits no purple/indigo/violet', () => {
        const { container } = withRuntime(<AppStat node={statNode({ captionSegments: SEGS })} />);
        const html = container.innerHTML;
        for (const re of FORBIDDEN) expect(re.test(html)).toBe(false);
    });
});

// ROLE_COLORS.success / .danger (styleResolver.js) as jsdom serializes them.
const ROLE_SUCCESS_RGB = 'rgb(16, 185, 129)';
const ROLE_DANGER_RGB = 'rgb(239, 68, 68)';
