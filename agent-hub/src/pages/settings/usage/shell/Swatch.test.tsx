import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Swatch } from './Swatch';

describe('Swatch', () => {
    it('is hidden from assistive tech and carries the colour', () => {
        const { container } = render(<Swatch color="rgb(1, 2, 3)" />);
        const el = container.firstElementChild as HTMLElement;
        expect(el.getAttribute('aria-hidden')).toBe('true');
        expect(el.style.backgroundColor).toBe('rgb(1, 2, 3)');
    });

    it('lets className override the size and shape', () => {
        const { container } = render(<Swatch color="red" className="h-3 w-3 rounded-full" />);
        const el = container.firstElementChild as HTMLElement;
        expect(el.className).toContain('rounded-full');
        expect(el.className).not.toContain('rounded-sm');
    });
});
