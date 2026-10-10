import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testQueryClient, withQueryClient } from '../../../test/queryWrapper';
import { ProjectLiveProvider } from './ProjectLiveContext';
import ProjectRail from './ProjectRail';

vi.mock('../../../hooks/useTranslation', () => ({ default: () => ({ t: (_k: string, f: string, p?: Record<string, unknown>) => f.replace('{n}', String(p?.n ?? '')).replace('{name}', String(p?.name ?? '')), locale: 'en' }) }));
vi.mock('../../../hooks/useProjectStream', () => ({ default: () => {} }));
const viewport = { isDesktop: true, isCompact: false, isMobile: false, width: 1920 };
vi.mock('../../../hooks/useViewport', () => ({ default: () => viewport, useViewport: () => viewport }));

const project = { id: 'p1', name: 'Product launch', kind: 'workspace', ownerId: 'me', color: '#f59e0b', icon: '🚀', role: 'owner' };
function seed(client: ReturnType<typeof testQueryClient>) {
    client.setQueryData(['projects', 'p1', 'detail'], project);
    client.setQueryData(['projects', 'p1', 'tasks'], { tasks: [{ id: 't1', status: 'todo' }, { id: 't2', status: 'done' }] });
    client.setQueryData(['projects', 'p1', 'members'], { ownerId: 'me', members: [{ sharedWithType: 'user', sharedWithId: 'fb' }], people: { me: { name: 'Sam' }, fb: { name: 'Femke' } } });
}
function renderRail(over: Partial<React.ComponentProps<typeof ProjectRail>> = {}) {
    const client = testQueryClient();
    seed(client);
    const props = { projectId: 'p1', activeTab: 'tasks' as const, onSelectTab: vi.fn(), onBack: vi.fn(), onOpenProject: vi.fn(), onOpenSearch: vi.fn(), projects: [project, { ...project, id: 'p2', name: 'Website' }], currentUserId: 'me', notebooksEnabled: true, footer: <div data-testid="footer" />, ...over } as React.ComponentProps<typeof ProjectRail>;
    render(withQueryClient(<ProjectLiveProvider projectId="p1" currentUserId="me"><ProjectRail {...props} /></ProjectLiveProvider>, client));
    return props;
}

describe('ProjectRail', () => {
    afterEach(() => { viewport.isDesktop = true; viewport.isCompact = false; viewport.width = 1920; });
    it('shows the project, three groups, a count only where it is known, and the footer', () => {
        renderRail();
        expect(screen.getByTestId('project-rail-name')).toHaveTextContent('Product launch');
        expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Collaborate', 'Content', 'Manage']);
        expect(screen.getByTestId('project-rail-tasks-count')).toHaveTextContent('1');       // one open task
        expect(screen.queryByTestId('project-rail-documents-count')).toBeNull();                // resources not loaded: no 0
        expect(screen.getByTestId('project-rail-tasks')).toHaveAttribute('aria-current', 'page');
        expect(screen.getByTestId('footer')).toBeInTheDocument();
    });
    it('a row click selects the tab; Back and the search pill call out', async () => {
        const props = renderRail();
        await userEvent.click(screen.getByTestId('project-rail-chats'));
        expect(props.onSelectTab).toHaveBeenCalledWith('chats');
        await userEvent.click(screen.getByTestId('project-rail-back'));
        expect(props.onBack).toHaveBeenCalled();
        await userEvent.click(screen.getByTestId('project-rail-search'));
        expect(props.onOpenSearch).toHaveBeenCalled();
    });
    it('the switcher lists the other projects and "All projects"', async () => {
        const props = renderRail();
        await userEvent.click(screen.getByRole('button', { name: /Switch project/ }));
        const menu = screen.getByRole('menu');
        await userEvent.click(within(menu).getByRole('menuitem', { name: 'Website' }));
        expect(props.onOpenProject).toHaveBeenCalledWith('p2');
    });
    it('folds to icons under 1280px: labels stay for screen readers, counts hide', () => {
        viewport.isDesktop = false; viewport.isCompact = true; viewport.width = 1024;
        renderRail();
        expect(screen.getByTestId('project-rail')).toHaveAttribute('data-folded', 'true');
        expect(screen.getByTestId('project-rail-tasks')).toHaveAccessibleName('Tasks');
        expect(screen.queryByTestId('project-rail-tasks-count')).toBeNull();
    });
    it('the switcher is a keyboard menu: focus enters, Escape closes and returns to the trigger', async () => {
        renderRail();
        const trigger = screen.getByRole('button', { name: /Switch project/ });
        await userEvent.click(trigger);
        const menu = screen.getByRole('menu');
        expect(within(menu).getAllByRole('menuitem').length).toBeGreaterThan(0);
        await userEvent.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger).toHaveFocus();
    });
    it('folded: the switcher is still a clickable trigger', async () => {
        viewport.isDesktop = false; viewport.isCompact = true; viewport.width = 1024;
        const props = renderRail();
        await userEvent.click(screen.getByRole('button', { name: /Switch project/ }));
        await userEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Website' }));
        expect(props.onOpenProject).toHaveBeenCalledWith('p2');
    });
    it('a legacy tab in the URL still highlights a row', () => {
        renderRail({ activeTab: 'threads' as never });
        expect(screen.getByTestId('project-rail-chats')).toHaveAttribute('aria-current', 'page');
    });
    it('the switcher keeps the project name in its accessible name', () => {
        renderRail();
        expect(screen.getByRole('button', { name: 'Switch project, current: Product launch' })).toBeInTheDocument();
    });
    it('a project that cannot be loaded leaves only Back and the footer', async () => {
        const client = testQueryClient();
        const props = { projectId: 'p1', activeTab: 'tasks' as const, onSelectTab: vi.fn(), onBack: vi.fn(), onOpenProject: vi.fn(), onOpenSearch: vi.fn(), projects: [], currentUserId: 'me', notebooksEnabled: true, footer: <div data-testid="footer" /> };
        await client.fetchQuery({ queryKey: ['projects', 'p1', 'detail'], queryFn: () => Promise.reject(new Error('404')), retry: false }).catch(() => {});
        render(withQueryClient(<ProjectLiveProvider projectId="p1" currentUserId="me"><ProjectRail {...props} /></ProjectLiveProvider>, client));
        expect(await screen.findByTestId('project-rail-back')).toBeInTheDocument();
        expect(screen.getByTestId('footer')).toBeInTheDocument();
        expect(screen.queryByTestId('project-rail-search')).toBeNull();
        expect(screen.queryByTestId('project-rail-tasks')).toBeNull();
    });
});
