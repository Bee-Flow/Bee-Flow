import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { getIntegrationIcon } from './integrationIcons';

describe('getIntegrationIcon', () => {
    it('keeps the default size without options', () => {
        const { container } = render(getIntegrationIcon('github'));
        expect(container.querySelector('svg')).toHaveClass('w-5', 'h-5');
    });

    it('applies the requested size, for brand and fallback icons', () => {
        for (const id of ['github', 'no-such-integration']) {
            const { container } = render(getIntegrationIcon(id, { size: 22 }));
            const svg = container.querySelector('svg');
            expect(svg).toHaveAttribute('width', '22');
            expect(svg).toHaveAttribute('height', '22');
            expect(svg).not.toHaveClass('w-5');
        }
    });
});
