import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../../../test/queryWrapper';

vi.mock('../documentQueries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../documentQueries')>()),
    useStarters: () => ({ data: [], isPending: false, isError: false }),
}));

import StarterGallery from './StarterGallery';

const base = { open: true, busy: false, error: null, onClose: vi.fn() };

describe('StarterGallery: own templates', () => {
    it('lists them between the starters and the presentations, and hands the chosen one back', async () => {
        const user = userEvent.setup();
        const onChoose = vi.fn();
        const template = { id: 't1', name: 'Quarterly report', docType: 'report' };
        render(withQueryClient(<StarterGallery {...base} templates={[template, { id: 't2', name: 'Pitch', docType: 'presentation' }]} onChoose={onChoose} />));
        const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent);
        expect(headings).toEqual(['From a template', 'Your templates', 'Presentations']);
        await user.click(screen.getByRole('button', { name: 'Quarterly report' }));
        expect(onChoose).toHaveBeenCalledWith({ type: 'template', template });
    });

    it('shows no section without templates', () => {
        render(withQueryClient(<StarterGallery {...base} onChoose={vi.fn()} />));
        expect(screen.queryByText('Your templates')).not.toBeInTheDocument();
    });
});
