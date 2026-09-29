import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppHeading from './AppHeading';

/**
 * AppHeading — levels plus the look pass (`props.accent`, spec
 * componentSpecs.js). 'none' (or absent/unknown) is the identity: the exact
 * pre-accent class string, no style attribute, no extra children.
 */

const headingNode = (props = {}) => ({
    id: 'cmp_h', type: 'heading', visible: true,
    props: { text: 'Section', level: 2, ...props },
    style: { span: 12 },
});

describe('AppHeading', () => {
    it('renders the level tag with its pinned classes', () => {
        const { getByText } = render(<AppHeading node={headingNode({ level: 1 })} />);
        const h = getByText('Section');
        expect(h.tagName).toBe('H1');
        expect(h.className).toBe('text-2xl font-semibold break-words');
    });

    it('clamps an out-of-range level to h2', () => {
        const { getByText } = render(<AppHeading node={headingNode({ level: 9 })} />);
        expect(getByText('Section').tagName).toBe('H2');
    });
});

describe('AppHeading accent', () => {
    it("accent 'none' (default) renders the identity — no accent class, no style, no bar", () => {
        const { getByText } = render(<AppHeading node={headingNode({ accent: 'none' })} />);
        const h = getByText('Section');
        expect(h.className).toBe('text-xl font-semibold break-words');
        expect(h.getAttribute('style')).toBeNull();
        expect(h.querySelector('span')).toBeNull();
    });

    it('an absent accent renders the identity too (stored definitions)', () => {
        const { getByText } = render(<AppHeading node={headingNode()} />);
        const h = getByText('Section');
        expect(h.className).toBe('text-xl font-semibold break-words');
        expect(h.getAttribute('style')).toBeNull();
    });

    it('an unknown accent value falls back to the identity render', () => {
        const { getByText } = render(<AppHeading node={headingNode({ accent: 'loud' })} />);
        const h = getByText('Section');
        expect(h.className).toBe('text-xl font-semibold break-words');
        expect(h.getAttribute('style')).toBeNull();
    });

    it("accent 'bar' stamps its class and draws the decorative primary bar", () => {
        const { container } = render(<AppHeading node={headingNode({ accent: 'bar' })} />);
        const h = container.querySelector('h2');
        expect(h.className).toContain('app-heading--bar');
        const bar = h.querySelector('span[aria-hidden]');
        expect(bar).toBeTruthy();
        expect(h.textContent).toContain('Section');
    });

    it("accent 'tinted' stamps its class on the heading itself", () => {
        const { getByText } = render(<AppHeading node={headingNode({ accent: 'tinted' })} />);
        const h = getByText('Section');
        expect(h.className).toContain('app-heading--tinted');
    });

    it('emits no purple/indigo/violet in any accent', () => {
        for (const accent of ['bar', 'tinted']) {
            const { container } = render(<AppHeading node={headingNode({ accent })} />);
            expect(/purple|violet|indigo|#6366f1|#7c3aed/i.test(container.innerHTML), accent).toBe(false);
        }
    });
});
