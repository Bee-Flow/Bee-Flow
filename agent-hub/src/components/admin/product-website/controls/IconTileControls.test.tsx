/**
 * Run: cd agent-hub && npx vitest run src/components/admin/product-website/controls/IconTileControls.test.tsx --maxWorkers=2
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import IconTileControls from './IconTileControls';

describe('IconTileControls', () => {
    it('reports a shape choice as an enum member', async () => {
        const onChange = vi.fn();
        render(<IconTileControls components={{}} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: 'Hexagon' }));
        expect(onChange).toHaveBeenCalledWith('tileShape', 'hexagon');
    });

    it('reports fill, size and icon colour under their own keys', async () => {
        const onChange = vi.fn();
        render(<IconTileControls components={{ tileFill: 'tint' }} onChange={onChange} />);
        await userEvent.click(screen.getByRole('button', { name: 'Solid' }));
        await userEvent.click(screen.getByRole('button', { name: 'Large' }));
        await userEvent.click(screen.getByRole('button', { name: 'White' }));
        expect(onChange.mock.calls).toEqual([['tileFill', 'solid'], ['tileSize', 'lg'], ['tileIconColor', 'light']]);
    });
});
