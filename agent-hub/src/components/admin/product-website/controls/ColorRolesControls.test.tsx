/**
 * Run: cd agent-hub && npx vitest run src/components/admin/product-website/controls/ColorRolesControls.test.tsx --maxWorkers=2
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import ColorRolesControls from './ColorRolesControls';

describe('ColorRolesControls', () => {
    it('shows one color row per role and the label style choices', () => {
        render(<ColorRolesControls colors={{ cta: '#112233' }} components={{}} onColor={vi.fn()} onComponent={vi.fn()} />);
        for (const name of ['Buttons', 'Links', 'Highlights', 'Icon tiles']) {
            expect(screen.getByText(name)).toBeTruthy();
        }
        expect(screen.getByRole('button', { name: 'Plain' })).toBeTruthy();
    });

    it('reports a label style choice as an enum member', async () => {
        const onComponent = vi.fn();
        render(<ColorRolesControls colors={{}} components={{}} onColor={vi.fn()} onComponent={onComponent} />);
        await userEvent.click(screen.getByRole('button', { name: 'Plain' }));
        expect(onComponent).toHaveBeenCalledWith('labelStyle', 'plain');
    });
});
