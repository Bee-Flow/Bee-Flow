import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppCallout from './AppCallout';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * AppCallout (spec: server/appStudio/componentSpecs.js).
 *
 * Identity: title/text/tone render the exact original markup — the tone hexes
 * now come from ROLE_COLORS (styleResolver) but are the same values, so the
 * tint and border bytes are unchanged. Additions: textFrom (wins over the
 * literal), toneFrom (invalid values fall back to `tone`), and a right-aligned
 * muted meta line (meta/metaFrom).
 */

function withRuntime(ui, overrides = {}) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }), ...overrides };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const calloutNode = (props = {}) => ({
    id: 'cmp_call', type: 'callout', visible: true,
    props: { title: null, text: 'Heads up.', tone: 'info', ...props },
    style: { span: 12 },
});

describe('AppCallout — identity', () => {
    // The house hexes, as jsdom's CSSOM serializes them.
    const RGB = {
        info: 'rgb(14, 165, 233)',
        success: 'rgb(16, 185, 129)',
        warning: 'rgb(245, 158, 11)',
        danger: 'rgb(239, 68, 68)',
    };

    it('renders the original tinted note: 10% wash, 3px left border, tone icon', () => {
        const { container, getByText } = withRuntime(<AppCallout node={calloutNode()} />);
        const root = container.firstChild;
        expect(getByText('Heads up.')).toBeTruthy();
        // `${color}1a` — the ~10% alpha tint of the info hex.
        expect(root.style.background).toContain('rgba(14, 165, 233');
        expect(root.style.borderLeft).toBe(`3px solid ${RGB.info}`);
        expect(container.querySelector('svg')).toBeTruthy();
        expect(container.querySelector('[data-app-callout-meta]')).toBeNull();
    });

    it('each tone keeps its house hex (warning/danger/success)', () => {
        for (const tone of ['success', 'warning', 'danger']) {
            const { container, unmount } = withRuntime(<AppCallout node={calloutNode({ tone })} />);
            expect(container.firstChild.style.borderLeft, tone).toBe(`3px solid ${RGB[tone]}`);
            unmount();
        }
    });

    it('renders the bold title line above the text', () => {
        const { getByText } = withRuntime(<AppCallout node={calloutNode({ title: 'Nog niet klaar' })} />);
        expect(getByText('Nog niet klaar').className).toContain('font-medium');
    });
});

describe('AppCallout — textFrom', () => {
    it('wins over the literal text when it resolves', () => {
        const { queryByText, getByText } = withRuntime(
            <AppCallout node={calloutNode({ textFrom: { kind: 'static', value: 'Live tekst.' } })} />,
        );
        expect(getByText('Live tekst.')).toBeTruthy();
        expect(queryByText('Heads up.')).toBeNull();
    });

    it('falls back to the literal while the binding resolves to nothing', () => {
        const { getByText } = withRuntime(
            <AppCallout node={calloutNode({ textFrom: { kind: 'static', value: null } })} />,
        );
        expect(getByText('Heads up.')).toBeTruthy();
    });

    it('resolves against the runtime scope', () => {
        const { getByText } = withRuntime(
            <AppCallout node={calloutNode({ textFrom: { kind: 'formula', expr: 'vars.msg' } })} />,
            { scope: buildScope({ vars: { msg: '2 regels missen materiaal.' }, now: '2026-01-01T00:00:00.000Z' }) },
        );
        expect(getByText('2 regels missen materiaal.')).toBeTruthy();
    });
});

describe('AppCallout — toneFrom', () => {
    it('a valid runtime tone overrides the static tone', () => {
        const { container } = withRuntime(
            <AppCallout node={calloutNode({ tone: 'info', toneFrom: { kind: 'static', value: 'danger' } })} />,
        );
        expect(container.firstChild.style.borderLeft).toBe('3px solid rgb(239, 68, 68)');
    });

    it('an invalid runtime value falls back to the static tone', () => {
        const { container } = withRuntime(
            <AppCallout node={calloutNode({ tone: 'warning', toneFrom: { kind: 'static', value: 'loud' } })} />,
        );
        expect(container.firstChild.style.borderLeft).toBe('3px solid rgb(245, 158, 11)');
    });
});

describe('AppCallout — meta line', () => {
    it('renders right-aligned, muted and nowrap', () => {
        const { container } = withRuntime(
            <AppCallout node={calloutNode({ meta: 'Daniel · 22 aug' })} />,
        );
        const meta = container.querySelector('[data-app-callout-meta]');
        expect(meta.textContent).toBe('Daniel · 22 aug');
        expect(meta.className).toContain('ml-auto');
        expect(meta.className).toContain('whitespace-nowrap');
        expect(meta.style.color).toBe('var(--text-muted)');
    });

    it('metaFrom wins over the literal meta', () => {
        const { container } = withRuntime(
            <AppCallout node={calloutNode({ meta: 'vast', metaFrom: { kind: 'static', value: '19 dagen stil' } })} />,
        );
        expect(container.querySelector('[data-app-callout-meta]').textContent).toBe('19 dagen stil');
    });

    it('an object metaFrom never renders raw JSON — the literal stays', () => {
        const { container } = withRuntime(
            <AppCallout node={calloutNode({ meta: 'vast', metaFrom: { kind: 'static', value: { a: 1 } } })} />,
        );
        expect(container.querySelector('[data-app-callout-meta]').textContent).toBe('vast');
    });
});

describe('AppCallout — no purple', () => {
    it('emits no purple/indigo/violet in any tone', () => {
        for (const tone of ['info', 'success', 'warning', 'danger']) {
            const { container, unmount } = withRuntime(<AppCallout node={calloutNode({ tone })} />);
            expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML), tone).toBe(false);
            unmount();
        }
    });
});

/**
 * `collapsible` — a note worth keeping that is not worth six permanent lines.
 * An AI summary sitting above the conversation it summarises is the case: you
 * want it there, you do not want to scroll past it every time.
 */
describe('AppCallout collapsible', () => {
    const long = 'TechNikkels bevestigt inkooporder PO24118 voor 9 posities, te leveren 13 juli bij Alulox.';

    it('keeps the whole text in the DOM — the cut is CSS, not content', () => {
        // Truncating in JS would hide the text from screen readers and from
        // find-in-page; the class narrows the line, the text stays whole.
        const { container } = withRuntime(<AppCallout node={calloutNode({ text: long, collapsible: true })} />);
        const body = container.querySelector('.app-callout__body');
        expect(body.textContent).toBe(long);
        expect(container.querySelector('.app-callout--collapsed')).toBeTruthy();
    });

    it('carries a hover panel that assistive tech does not read twice', () => {
        const { container } = withRuntime(<AppCallout node={calloutNode({ text: long, collapsible: true })} />);
        const peek = container.querySelector('.app-callout__peek');
        expect(peek).toBeTruthy();
        expect(peek.getAttribute('aria-hidden')).toBe('true');
        expect(peek.textContent).toBe(long);
    });

    it('is reachable by keyboard, so the panel is not mouse-only', () => {
        const { container } = withRuntime(<AppCallout node={calloutNode({ text: long, collapsible: true })} />);
        expect(container.querySelector('[data-app-callout]').getAttribute('tabindex')).toBe('0');
    });

    it('renders exactly as before when it is not collapsible', () => {
        const { container } = withRuntime(<AppCallout node={calloutNode({ text: long })} />);
        expect(container.querySelector('.app-callout--collapsed')).toBeNull();
        expect(container.querySelector('.app-callout__peek')).toBeNull();
        expect(container.querySelector('[data-app-callout]').hasAttribute('tabindex')).toBe(false);
    });
});
