import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import Integrations from './Integrations';

describe('Integrations tiles', () => {
    it('gives an item without a brand mark the neutral icon tile, not the accent one', () => {
        const data = {
            enabled: true,
            categories: [{ heading: 'Tools', items: [{ label: 'Zzz Unknown Tool', icon: 'Star' }] }],
        };
        const { container } = render(<Integrations data={data} />);
        const tile = container.querySelector('.integration-item .icon-tile');
        expect(tile).not.toBeNull();
        expect(tile?.classList.contains('icon-tile--neutral')).toBe(true);
    });
});
