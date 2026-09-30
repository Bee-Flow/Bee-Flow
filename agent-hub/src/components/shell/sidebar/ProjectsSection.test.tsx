import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';

import ProjectsSection, { type ProjectsSectionProps } from './ProjectsSection';
import type { Project } from '../../../api/queries/projects';

/**
 * The projects group in the sidebar.
 *
 * It lists the collaborative project workspaces you belong to. A row opens the
 * project's home and makes it the chat context; the hover "+" starts a new
 * chat in it. `t` arrives as a prop (Sidebar owns the hook), so the tests pass
 * a translator that returns the English fallback with its parameters filled
 * in, and pin the key where the wording does not matter.
 */

const t = ((key: string, fallback?: unknown, params?: Record<string, unknown>) => {
    const text = typeof fallback === 'string' ? fallback : key;
    return text.replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? ''));
}) as ProjectsSectionProps['t'];

const OWNED: Project = { id: 'p1', name: 'Onboarding', permission: 'owner', icon: '🚀', color: '#22c55e' };
const SHARED: Project = { id: 'p2', name: 'Billing', permission: 'editor' };
const BARE: Project = { id: 'p3', name: 'Legacy' };

const renderSection = (props: Partial<ProjectsSectionProps> = {}) => render(
    <ProjectsSection
        t={t}
        projects={[OWNED, SHARED]}
        projectsOpen
        toggleProjects={() => {}}
        activeProject={null}
        {...props}
    />,
);

describe('the group header', () => {
    it('labels itself from the sidebar dictionary', () => {
        renderSection();
        expect(screen.getByText('Projects')).toBeInTheDocument();
    });

    it('creates a project without collapsing the group', async () => {
        const onCreateProject = vi.fn();
        const toggleProjects = vi.fn();
        renderSection({ onCreateProject, toggleProjects });
        await userEvent.click(screen.getByRole('button', { name: 'New Project' }));
        expect(onCreateProject).toHaveBeenCalledTimes(1);
        expect(toggleProjects).not.toHaveBeenCalled();
    });

    it('collapses to nothing but the header when closed', () => {
        renderSection({ projectsOpen: false });
        expect(screen.queryByText('Onboarding')).toBeNull();
        expect(screen.queryByText('All projects')).toBeNull();
        expect(screen.getByText('Projects')).toBeInTheDocument();
    });

    it('toggles when the header is clicked', async () => {
        const toggleProjects = vi.fn();
        renderSection({ toggleProjects });
        await userEvent.click(screen.getByText('Projects'));
        expect(toggleProjects).toHaveBeenCalledTimes(1);
    });
});

describe('the rows', () => {
    it('lists one row per project plus the way into the full list', () => {
        renderSection();
        expect(screen.getByText('Onboarding')).toBeInTheDocument();
        expect(screen.getByText('Billing')).toBeInTheDocument();
        expect(screen.getByText('All projects')).toBeInTheDocument();
    });

    it('still offers the way into the full list when you have no projects', () => {
        renderSection({ projects: [] });
        expect(screen.getByText('All projects')).toBeInTheDocument();
    });

    it('falls back to a folder icon for a project with none', () => {
        const { container } = renderSection({ projects: [SHARED] });
        expect(container.textContent).toContain('📁');
    });

    it('opens the project when its row is clicked', async () => {
        const onOpenProject = vi.fn();
        renderSection({ onOpenProject });
        await userEvent.click(screen.getByText('Onboarding'));
        expect(onOpenProject).toHaveBeenCalledWith(OWNED);
    });

    it('opens the project again, rather than clearing it, when the active row is clicked', async () => {
        const onOpenProject = vi.fn();
        renderSection({ onOpenProject, activeProject: OWNED });
        await userEvent.click(screen.getByText('Onboarding'));
        expect(onOpenProject).toHaveBeenCalledWith(OWNED);
    });

    it('marks the chat context project as the current row', () => {
        renderSection({ activeProject: SHARED });
        expect(screen.getByText('Billing').closest('button')).toHaveAttribute('aria-current', 'true');
        expect(screen.getByText('Onboarding').closest('button')).not.toHaveAttribute('aria-current');
    });

    it('starts a new chat in a project from its "+" without opening it', async () => {
        const onOpenProject = vi.fn();
        const onNewChatInProject = vi.fn();
        renderSection({ onOpenProject, onNewChatInProject });
        await userEvent.click(screen.getByRole('button', { name: 'New chat in Billing' }));
        expect(onNewChatInProject).toHaveBeenCalledWith(SHARED);
        expect(onOpenProject).not.toHaveBeenCalled();
    });

    it('opens the full list from the last row', async () => {
        const onBrowseProjects = vi.fn();
        renderSection({ onBrowseProjects });
        await userEvent.click(screen.getByText('All projects'));
        expect(onBrowseProjects).toHaveBeenCalledTimes(1);
    });
});

describe('ownership in the sidebar', () => {
    it('badges a project someone else shared with you', () => {
        renderSection({ projects: [SHARED] });
        expect(screen.getByText('shared')).toBeInTheDocument();
    });

    it('reads the role from `role` when the list row names it that way', () => {
        renderSection({ projects: [{ id: 'p9', name: 'Ops', role: 'viewer' }] });
        expect(screen.getByText('shared')).toBeInTheDocument();
    });

    it('leaves your own project unbadged', () => {
        renderSection({ projects: [OWNED] });
        expect(screen.queryByText('shared')).toBeNull();
    });

    it('does not call a project with no role "shared": unknown is not someone else\'s', () => {
        renderSection({ projects: [BARE] });
        expect(screen.queryByText('shared')).toBeNull();
    });
});

describe('the project colour', () => {
    it('never paints a colour that is not a plain hex value', () => {
        renderSection({ projects: [{ ...OWNED, color: 'red;background:url(https://tracker.example/x)' }] });
        expect(screen.getByText('🚀').getAttribute('style') || '').not.toContain('tracker.example');
    });
});
