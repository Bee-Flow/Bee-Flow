import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '../../api/queries/projects';
import ProjectsHome, { listRole, type ProjectsHomeProps } from './ProjectsHome';

const { gate } = vi.hoisted(() => ({ gate: { feature: '' as string | undefined, allowed: true } }));
// Behaves like RequireTier's feature branch: the page, or the upgrade panel.
vi.mock('../licensing/LicenseContext', () => ({
    RequireTier: ({ feature, children }: { feature?: string; children: React.ReactNode }) => {
        gate.feature = feature;
        return gate.allowed ? <>{children}</> : <div data-testid="upgrade-panel" />;
    },
}));

const ME = 'me';
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

const PROJECTS: Project[] = [
    { id: 'a', name: 'Budget 2027', description: 'Numbers', permission: 'owner', updatedAt: ago(3), icon: '📊', color: '#22c55e' },
    { id: 'b', name: 'Acme onboarding', permission: 'editor', updatedAt: ago(1) },
    { id: 'c', name: 'Handbook', permission: 'viewer', updatedAt: ago(10) },
    // A row from a server that did not say the role: owned by me per ownerId.
    { id: 'd', name: 'Zeta', ownerId: ME, updatedAt: ago(0.5) },
];

function renderHome(over: Partial<ProjectsHomeProps> = {}) {
    const props: ProjectsHomeProps = {
        projects: PROJECTS, user: { id: ME }, onSelectProject: vi.fn(), onCreateProject: vi.fn(), onClose: vi.fn(), ...over,
    };
    render(<ProjectsHome {...props} />);
    return { props, user: userEvent.setup() };
}

const cardOrder = () => screen.getAllByTestId(/^project-card-/).map((el) => el.dataset.testid?.replace('project-card-', ''));

describe('ProjectsHome — list', () => {
    it('is gated on the projects licence feature', () => {
        gate.allowed = false;
        renderHome();
        expect(screen.getByTestId('upgrade-panel')).toBeInTheDocument();
        expect(gate.feature).toBe('projects');
        gate.allowed = true;
    });

    it('shows every project newest first, with the count and role badges', () => {
        renderHome();
        expect(cardOrder()).toEqual(['d', 'b', 'a', 'c']);
        expect(screen.getByTestId('studio-section-status')).toHaveTextContent('4');
        expect(within(screen.getByTestId('project-card-b')).getByText('Shared · can edit')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-card-c')).getByText('Shared · can view')).toBeInTheDocument();
        expect(within(screen.getByTestId('project-card-a')).getByText('Owner')).toBeInTheDocument();
    });

    it('filters Mine and Shared, searches, and sorts A–Z', async () => {
        const { user } = renderHome();
        await user.click(screen.getByRole('button', { name: /Mine/ }));
        expect(cardOrder()).toEqual(['d', 'a']);
        await user.click(screen.getByRole('button', { name: /Shared with me/ }));
        expect(cardOrder()).toEqual(['b', 'c']);
        await user.click(screen.getByRole('button', { name: /^All/ }));
        await user.click(screen.getByRole('radio', { name: 'A–Z' }));
        expect(cardOrder()).toEqual(['b', 'a', 'c', 'd']);
        await user.type(screen.getByTestId('projects-search'), 'hand');
        expect(cardOrder()).toEqual(['c']);
    });

    it('explains an empty search and clears it', async () => {
        const { user } = renderHome();
        await user.type(screen.getByTestId('projects-search'), 'nothing like this');
        expect(screen.getByTestId('projects-no-match')).toHaveTextContent('No projects match “nothing like this”.');
        await user.click(screen.getByRole('button', { name: 'Show all projects' }));
        expect(cardOrder()).toHaveLength(4);
    });

    it('opens a project, creates one and goes back', async () => {
        const { props, user } = renderHome();
        await user.click(screen.getByTestId('project-card-a'));
        expect(props.onSelectProject).toHaveBeenCalledWith(PROJECTS[0]);
        await user.click(screen.getByTestId('projects-create'));
        expect(props.onCreateProject).toHaveBeenCalled();
        await user.click(screen.getByRole('button', { name: 'Back to chat' }));
        expect(props.onClose).toHaveBeenCalled();
    });
});

describe('ProjectsHome — empty, loading and failure', () => {
    it('explains what a project is for when there is none', async () => {
        const { props, user } = renderHome({ projects: [] });
        expect(screen.getByTestId('projects-empty')).toHaveTextContent('Keep documents, notebooks and meeting notes together.');
        await user.click(screen.getByTestId('projects-empty-create'));
        expect(props.onCreateProject).toHaveBeenCalled();
    });

    it('does not show "no projects" while loading or after a failure', () => {
        renderHome({ projects: [], loading: true });
        expect(screen.queryByTestId('projects-empty')).toBeNull();
        expect(screen.queryByTestId('studio-section-status')).toBeNull();
    });

    it('says the list could not load', () => {
        renderHome({ projects: [], error: 'Network down' });
        expect(screen.getByTestId('projects-error')).toHaveTextContent('Could not load your projects: Network down');
        expect(screen.queryByTestId('projects-empty')).toBeNull();
    });
});

describe('listRole', () => {
    it('reads the role the server sent, else ownership, else nothing', () => {
        expect(listRole({ id: 'x', name: 'x', permission: 'editor' }, ME)).toBe('editor');
        expect(listRole({ id: 'x', name: 'x', ownerId: ME }, ME)).toBe('owner');
        expect(listRole({ id: 'x', name: 'x', ownerId: 'someone' }, ME)).toBeNull();
    });
});
