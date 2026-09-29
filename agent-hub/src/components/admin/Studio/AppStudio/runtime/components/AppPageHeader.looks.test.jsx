import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppPageHeader from './AppPageHeader';
import { RuntimeProvider, buildScope, DEFAULT_RUNTIME } from '../RuntimeContext';

/**
 * AppPageHeader — the look pass (props.look, spec componentSpecs.js).
 * 'plain' (or absent/unknown) is the identity: the exact pre-look header —
 * no look class, no data-app-pageheader-look, no style attribute on the root.
 * (The pre-look behaviour itself is pinned in v21Static.test.jsx — this file
 * only owns the look additions, so parallel work on that shared file stays
 * conflict-free.)
 */

function withRuntime(ui) {
    const value = { ...DEFAULT_RUNTIME, scope: buildScope({ now: '2026-01-01T00:00:00.000Z' }) };
    return render(<RuntimeProvider value={value}>{ui}</RuntimeProvider>);
}

const headerNode = (props = {}) => ({
    id: 'cmp_ph', type: 'page_header', visible: true,
    props: { title: 'Projects', subtitle: 'All of them', icon: null, showDivider: true, ...props },
    style: { span: 12, gap: 3, padding: 0 },
});

const rootOf = (container) => container.querySelector('[data-app-pageheader]');

describe('AppPageHeader looks', () => {
    it("look 'plain' (default) renders the identity — no look class/attr/style, divider intact", () => {
        const { container } = withRuntime(
            <AppPageHeader node={headerNode({ look: 'plain' })}><button type="button">New</button></AppPageHeader>,
        );
        const root = rootOf(container);
        expect(root.className).toBe('w-full min-w-0');
        expect(root.getAttribute('data-app-pageheader-look')).toBeNull();
        expect(root.getAttribute('style')).toBeNull();
        expect(container.querySelector('hr')).toBeTruthy();
    });

    it('an absent look renders the identity too (stored definitions)', () => {
        const { container } = withRuntime(<AppPageHeader node={headerNode()} />);
        const root = rootOf(container);
        expect(root.className).toBe('w-full min-w-0');
        expect(root.getAttribute('data-app-pageheader-look')).toBeNull();
        expect(root.getAttribute('style')).toBeNull();
    });

    it('an unknown look value falls back to the identity render', () => {
        const { container } = withRuntime(<AppPageHeader node={headerNode({ look: 'shout' })} />);
        const root = rootOf(container);
        expect(root.className).toBe('w-full min-w-0');
        expect(root.getAttribute('style')).toBeNull();
    });

    it("look 'banner' stamps its class and drops the divider (the band closes the header)", () => {
        const { container, getByText } = withRuntime(
            <AppPageHeader node={headerNode({ look: 'banner' })}><button type="button">New</button></AppPageHeader>,
        );
        const root = rootOf(container);
        expect(root.className).toContain('app-pageheader--banner');
        expect(root.getAttribute('data-app-pageheader-look')).toBe('banner');
        expect(container.querySelector('hr')).toBeNull();
        expect(getByText('Projects').tagName).toBe('H1');
        expect(container.querySelector('[data-app-pageheader-actions]')).toBeTruthy();
    });

    it("look 'hero' goes large and centered, gradient band, no divider", () => {
        const { container, getByText } = withRuntime(
            <AppPageHeader node={headerNode({ look: 'hero' })}><button type="button">New</button></AppPageHeader>,
        );
        const root = rootOf(container);
        expect(root.className).toContain('app-pageheader--hero');
        expect(root.getAttribute('data-app-pageheader-look')).toBe('hero');
        const h1 = getByText('Projects');
        expect(h1.className).toContain('text-3xl');
        expect(container.querySelector('hr')).toBeNull();
        expect(container.querySelector('[data-app-pageheader-actions]')).toBeTruthy();
    });

    it("look 'split' pushes the subtitle right (muted) and keeps the hairline", () => {
        const { container, getByText } = withRuntime(
            <AppPageHeader node={headerNode({ look: 'split' })}><button type="button">New</button></AppPageHeader>,
        );
        const root = rootOf(container);
        expect(root.className).toContain('app-pageheader--split');
        const subtitle = getByText('All of them');
        expect(subtitle.className).toContain('text-right');
        expect(container.querySelector('hr')).toBeTruthy();
        expect(container.querySelector('[data-app-pageheader-actions]')).toBeTruthy();
    });

    it("look 'split' still honours showDivider:false", () => {
        const { container } = withRuntime(
            <AppPageHeader node={headerNode({ look: 'split', showDivider: false })} />,
        );
        expect(container.querySelector('hr')).toBeNull();
    });

    it('titleFrom still wins over the literal in every look', () => {
        for (const look of ['banner', 'hero', 'split']) {
            // container-scoped: the loop keeps earlier renders mounted, so the
            // document-level getByText would see three matches.
            const { container } = withRuntime(
                <AppPageHeader node={headerNode({ look, titleFrom: { kind: 'static', value: 'Bound title' } })} />,
            );
            expect(container.querySelector('h1').textContent, look).toBe('Bound title');
        }
    });

    it('emits no purple/indigo/violet in any look', () => {
        for (const look of ['banner', 'hero', 'split']) {
            const { container } = withRuntime(<AppPageHeader node={headerNode({ look })} />);
            expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML), look).toBe(false);
        }
    });
});
