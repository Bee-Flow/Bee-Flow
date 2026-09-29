import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

import ProjectsSection from './ProjectsSection';

/**
 * CHARACTERISATION — the projects group in the sidebar (PRJ-0).
 *
 * This is the second place a project list is drawn, and it decides ownership by
 * a different rule than /app/projects does. Both are pinned so the redesign has
 * to reconcile them rather than pick one by accident.
 *
 * `t` arrives as a prop here (Sidebar owns the hook), so the tests pass an
 * identity translator and pin the KEY, not today's wording.
 */

const t = (key) => key;

const OWNED = { id: 'p1', name: 'Onboarding', permission: 'owner', icon: '🚀', color: '#22c55e' };
const SHARED = { id: 'p2', name: 'Billing', permission: 'editor' };
const BARE = { id: 'p3', name: 'Legacy' };

const renderSection = (props = {}) => render(
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
        const { getByText } = renderSection();
        expect(getByText('sidebar.projects')).toBeTruthy();
    });

    it('creates a project without collapsing the group', () => {
        const onCreateProject = vi.fn();
        const toggleProjects = vi.fn();
        const { getByTitle } = renderSection({ onCreateProject, toggleProjects });
        fireEvent.click(getByTitle('New Project'));
        expect(onCreateProject).toHaveBeenCalledTimes(1);
        expect(toggleProjects).not.toHaveBeenCalled();
    });

    it('collapses to nothing but the header when closed', () => {
        const { queryByText } = renderSection({ projectsOpen: false });
        expect(queryByText('Onboarding')).toBeNull();
        expect(queryByText('sidebar.all_projects')).toBeNull();
        expect(queryByText('sidebar.projects')).toBeTruthy();
    });
});

describe('the rows', () => {
    it('lists one row per project plus the way into the full list', () => {
        const { getByText } = renderSection();
        expect(getByText('Onboarding')).toBeTruthy();
        expect(getByText('Billing')).toBeTruthy();
        expect(getByText('sidebar.all_projects')).toBeTruthy();
    });

    it('still offers the way into the full list when you have no projects', () => {
        const { getByText } = renderSection({ projects: [] });
        expect(getByText('sidebar.all_projects')).toBeTruthy();
    });

    it('falls back to a folder icon for a project with none', () => {
        const { container } = renderSection({ projects: [SHARED] });
        expect(container.textContent).toContain('📁');
    });

    it('selects a project when its row is clicked', () => {
        const onSelectProject = vi.fn();
        const { getByText } = renderSection({ onSelectProject });
        fireEvent.click(getByText('Onboarding'));
        expect(onSelectProject).toHaveBeenCalledWith(OWNED);
    });

    it('clears the selection when the already-active project is clicked again', () => {
        const onSelectProject = vi.fn();
        const { getByText } = renderSection({ onSelectProject, activeProject: OWNED });
        fireEvent.click(getByText('Onboarding'));
        expect(onSelectProject).toHaveBeenCalledWith(null);
    });

    it('opens the full list from the last row', () => {
        const onBrowseProjects = vi.fn();
        const { getByText } = renderSection({ onBrowseProjects });
        fireEvent.click(getByText('sidebar.all_projects'));
        expect(onBrowseProjects).toHaveBeenCalledTimes(1);
    });
});

describe('ownership in the sidebar', () => {
    it('badges a project someone else shared with you', () => {
        const { container } = renderSection({ projects: [SHARED] });
        expect(container.textContent).toContain('shared');
    });

    it('leaves your own project unbadged', () => {
        const { container } = renderSection({ projects: [OWNED] });
        expect(container.textContent).not.toContain('shared');
    });

    it('offers the edit affordance on a project you own', () => {
        const { getByTitle } = renderSection({ projects: [OWNED] });
        expect(getByTitle('Edit project')).toBeTruthy();
    });

    it('withholds the edit affordance on a project shared with you', () => {
        const { queryByTitle } = renderSection({ projects: [SHARED] });
        expect(queryByTitle('Edit project')).toBeNull();
    });

    // wrat: with no permission field the sidebar treats the project as YOURS
    // (edit affordance, no "shared" badge) while ProjectsPage labels the very
    // same project "Viewer" and drops it from both of its filters. Two screens,
    // two rules, one row of data. Hoort in stage PRJ-3/PRJ-13 te veranderen.
    it('treats a project with no permission field as your own', () => {
        const { getByTitle, container } = renderSection({ projects: [BARE] });
        expect(getByTitle('Edit project')).toBeTruthy();
        expect(container.textContent).not.toContain('shared');
    });

    it('edits without also selecting the project', () => {
        const onEditProject = vi.fn();
        const onSelectProject = vi.fn();
        const { getByTitle } = renderSection({ projects: [OWNED], onEditProject, onSelectProject });
        fireEvent.click(getByTitle('Edit project'));
        expect(onEditProject).toHaveBeenCalledWith(OWNED);
        expect(onSelectProject).not.toHaveBeenCalled();
    });
});
