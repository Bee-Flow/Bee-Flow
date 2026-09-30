import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import RopaProjects, { type RopaProjectsBody } from './RopaProjects';

const BODY: RopaProjectsBody = {
    complete: true,
    projects: [
        { project_id: 'p1', name: 'Clinic', kinds: ['health', 'name'], special: true, sources: ['files'], registration: null },
        { project_id: 'p2', name: 'Agency', kinds: ['email'], special: false, registration: { lawful_basis: 'contract', confirmed_at: '2026-09-01T10:00:00Z' } },
    ],
};

describe('RopaProjects', () => {
    it('loading, failed, empty and partial each have their own line', () => {
        const { rerender } = render(<RopaProjects body={null} />);
        expect(screen.getByTestId('ropa-projects-loading')).toBeInTheDocument();
        rerender(<RopaProjects body={{ error: true }} />);
        expect(screen.getByTestId('ropa-projects-failed')).toBeInTheDocument();
        rerender(<RopaProjects body={{ projects: [], complete: true }} />);
        expect(screen.getByTestId('ropa-projects-empty')).toBeInTheDocument();
        rerender(<RopaProjects body={{ projects: [], complete: false }} />);
        expect(screen.getByTestId('ropa-projects-partial')).toBeInTheDocument();
    });

    it('lists projects with their kinds, special category and record', () => {
        render(<RopaProjects body={BODY} onSave={vi.fn()} />);
        expect(screen.getByTestId('ropa-project-p1')).toHaveTextContent('Health data, Names');
        expect(screen.getByTestId('ropa-project-special-p1')).toHaveTextContent('Special category');
        expect(screen.getByTestId('ropa-project-record-p1')).toHaveTextContent('None yet');
        expect(screen.getByTestId('ropa-project-record-p2')).toHaveTextContent('Contract · confirmed 2026-09-01');
    });

    it('records a purpose, basis and retention for a project', async () => {
        const onSave = vi.fn(async () => ({}));
        const user = userEvent.setup();
        render(<RopaProjects body={BODY} onSave={onSave} />);
        await user.click(screen.getByTestId('ropa-project-edit-p1'));
        const form = screen.getByRole('form', { name: 'Processing record for Clinic' });
        expect(screen.getByTestId('ropa-project-save-p1')).toBeDisabled();
        await user.type(screen.getByLabelText('Purpose'), 'Treatment notes');
        await user.selectOptions(screen.getByLabelText('Lawful basis'), 'legal_obligation');
        await user.type(screen.getByLabelText('Keep for (days, optional)'), '3650');
        await user.click(screen.getByTestId('ropa-project-save-p1'));
        expect(onSave).toHaveBeenCalledWith('p1', { purpose: 'Treatment notes', lawful_basis: 'legal_obligation', retention_days: 3650 });
        await waitFor(() => expect(form).not.toBeInTheDocument());
    });

    it('a failed save stays open and says so; a record can be removed', async () => {
        const user = userEvent.setup();
        const onRemove = vi.fn(async () => ({}));
        render(<RopaProjects body={BODY} onSave={vi.fn(async () => { throw new Error('500'); })} onRemove={onRemove} />);
        await user.click(screen.getByTestId('ropa-project-edit-p2'));
        await user.click(screen.getByTestId('ropa-project-save-p2'));
        expect(await screen.findByRole('alert')).toHaveTextContent('The record could not be saved.');
        await user.click(screen.getByTestId('ropa-project-remove-p2'));
        expect(onRemove).toHaveBeenCalledWith('p2');
    });

    it('opens the project when the host can navigate', async () => {
        const onNavigate = vi.fn();
        render(<RopaProjects body={BODY} onNavigate={onNavigate} />);
        await userEvent.setup().click(screen.getByRole('button', { name: /Clinic/ }));
        expect(onNavigate).toHaveBeenCalledWith('projects/p1');
    });
});
