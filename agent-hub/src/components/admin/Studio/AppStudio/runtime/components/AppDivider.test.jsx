import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import AppDivider from './AppDivider';

/**
 * divider.orientation (spec: server/appStudio/componentSpecs.js).
 * 'horizontal' — and absent props, and any unknown value — is the identity
 * path: the exact original full-width <hr>. 'vertical' is a 1px upright rule
 * that stretches in a flex row (page_header actions); runtime.css stretches
 * its wrapper cell, the component fills it.
 */

const node = (props) => ({ id: 'cmp_div', type: 'divider', props, style: { span: 12 } });

describe('AppDivider', () => {
    it('renders the identity horizontal rule with no props at all', () => {
        const { container } = render(<AppDivider />);
        const hr = container.querySelector('hr');
        expect(hr.className).toBe('border-t w-full');
        expect(hr.style.borderColor).toBe('var(--border-default)');
        expect(hr.getAttribute('data-app-divider')).toBeNull();
    });

    it("orientation 'horizontal' and unknown values render the identity too", () => {
        for (const orientation of ['horizontal', 'diagonal', undefined]) {
            const { container, unmount } = render(<AppDivider node={node({ orientation })} />);
            const hr = container.querySelector('hr');
            expect(hr.className, String(orientation)).toBe('border-t w-full');
            expect(hr.getAttribute('data-app-divider')).toBeNull();
            unmount();
        }
    });

    it("orientation 'vertical' renders a stretching 1px upright rule", () => {
        const { container } = render(<AppDivider node={node({ orientation: 'vertical' })} />);
        const hr = container.querySelector('hr');
        expect(hr.getAttribute('data-app-divider')).toBe('vertical');
        expect(hr.getAttribute('aria-orientation')).toBe('vertical');
        expect(hr.className).toContain('self-stretch');
        expect(hr.className).toContain('w-px');
        expect(hr.className).toContain('border-0');
        expect(hr.style.background).toBe('var(--border-default)');
        // Visible even where nothing stretches it (a plain grid row).
        expect(hr.style.minHeight).toBe('1.25rem');
        expect(hr.className).not.toContain('w-full');
    });
});
