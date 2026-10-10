import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '../test/queryWrapper';
import ProjectsView, { type ProjectsViewProps } from './ProjectsView';

/**
 * The seam between the hub and the projects pages: which page renders for a
 * route, and how every move out of a page comes back as a route.
 *
 * The two pages are stubbed: they have their own tests, and what matters here
 * is the wiring, not what they draw.
 */

vi.mock('../components/projects/ProjectsHome', () => ({
    default: (props: Record<string, any>) => (
        <div data-testid="projects-home">
            <span>{`home:${props.projects.length}:${props.loading ? 'loading' : 'ready'}:${props.error || ''}`}</span>
            <button type="button" onClick={() => props.onSelectProject({ id: 'p7', name: 'Seven' })}>open p7</button>
            <button type="button" onClick={() => props.onCreateProject()}>create</button>
            <button type="button" onClick={() => props.onClose()}>close</button>
        </div>
    ),
}));

vi.mock('../components/projects/workspace/ProjectWorkspacePage', () => ({
    default: (props: Record<string, any>) => (
        <div data-testid="project-workspace">
            <span>{`workspace:${props.projectId}:${props.initialTab ?? '-'}:${props.initialSub ?? '-'}`}</span>
            <button type="button" onClick={() => props.onRouteChange('documents', 'd1')}>route</button>
            <button type="button" onClick={() => props.onClose()}>back</button>
            <button type="button" onClick={() => props.onSaved({ id: 'new-id', name: 'Fresh' })}>saved</button>
            <button type="button" onClick={() => props.onDeleted('p1')}>deleted</button>
            <button type="button" onClick={() => props.onOpenThread({ id: 't1', type: 'direct' })}>thread</button>
            <button type="button" onClick={() => props.onNavigate('notebooks/n1')}>navigate</button>
            <button type="button" onClick={() => props.onStartChat({ project: { id: 'p1', name: 'One' }, message: 'Hi' })}>start</button>
        </div>
    ),
}));

function renderView(over: Partial<ProjectsViewProps> = {}) {
    const props: ProjectsViewProps = {
        route: { projectId: null },
        projects: [{ id: 'p1', name: 'One' }],
        loading: false,
        error: null,
        user: { id: 'u1' },
        onGoToProject: vi.fn(),
        onClose: vi.fn(),
        onSaved: vi.fn(),
        onDeleted: vi.fn(),
        onOpenThread: vi.fn(),
        onNavigate: vi.fn(),
        onStartChat: vi.fn(),
        ...over,
    };
    render(withQueryClient(<ProjectsView {...props} />));
    return props;
}

describe('the list', () => {
    it('renders the projects home for the list route, with the list state', async () => {
        renderView({ loading: true, error: 'Could not load your projects.' });
        expect(await screen.findByText('home:1:loading:Could not load your projects.')).toBeInTheDocument();
        expect(screen.queryByTestId('project-workspace')).toBeNull();
    });

    it('opens a project, the create form, or leaves', async () => {
        const props = renderView();
        await userEvent.click(await screen.findByText('open p7'));
        expect(props.onGoToProject).toHaveBeenLastCalledWith('p7');
        await userEvent.click(screen.getByText('create'));
        expect(props.onGoToProject).toHaveBeenLastCalledWith('');
        await userEvent.click(screen.getByText('close'));
        expect(props.onClose).toHaveBeenCalledTimes(1);
    });
});

describe('one workspace', () => {
    it('hands the tab and the item in it to the workspace', async () => {
        renderView({ route: { projectId: 'p1', tab: 'chats', sub: 'c1' } });
        expect(await screen.findByText('workspace:p1:chats:c1')).toBeInTheDocument();
    });

    it('writes a move inside the workspace back as a route', async () => {
        const props = renderView({ route: { projectId: 'p1', tab: 'overview' } });
        await userEvent.click(await screen.findByText('route'));
        expect(props.onGoToProject).toHaveBeenCalledWith('p1', 'documents', 'd1');
        await userEvent.click(screen.getByText('back'));
        expect(props.onGoToProject).toHaveBeenLastCalledWith(null);
    });

    it('passes the app-level handlers straight through', async () => {
        const props = renderView({ route: { projectId: 'p1' } });
        await userEvent.click(await screen.findByText('thread'));
        expect(props.onOpenThread).toHaveBeenCalledWith({ id: 't1', type: 'direct' });
        await userEvent.click(screen.getByText('navigate'));
        expect(props.onNavigate).toHaveBeenCalledWith('notebooks/n1');
        await userEvent.click(screen.getByText('start'));
        expect(props.onStartChat).toHaveBeenCalledWith({ project: { id: 'p1', name: 'One' }, message: 'Hi' });
        await userEvent.click(screen.getByText('deleted'));
        expect(props.onDeleted).toHaveBeenCalledWith('p1');
    });

    it('does not jump to another project when an existing one is saved', async () => {
        const props = renderView({ route: { projectId: 'p1' } });
        await userEvent.click(await screen.findByText('saved'));
        expect(props.onSaved).toHaveBeenCalledWith({ id: 'new-id', name: 'Fresh' });
        expect(props.onGoToProject).not.toHaveBeenCalled();
    });
});

describe('the create form', () => {
    it('moves to the project it just created', async () => {
        const props = renderView({ route: { projectId: '' } });
        expect(await screen.findByText('workspace::-:-')).toBeInTheDocument();
        await userEvent.click(screen.getByText('saved'));
        expect(props.onSaved).toHaveBeenCalledWith({ id: 'new-id', name: 'Fresh' });
        expect(props.onGoToProject).toHaveBeenCalledWith('new-id');
    });

    it('ignores route changes while there is no project yet', async () => {
        const props = renderView({ route: { projectId: '' } });
        await userEvent.click(await screen.findByText('route'));
        expect(props.onGoToProject).not.toHaveBeenCalled();
    });
});
