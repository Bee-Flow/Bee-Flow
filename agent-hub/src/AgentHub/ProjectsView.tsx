import React, { type LazyExoticComponent, Suspense } from 'react';
import { useProjectsQuery, type Project } from '../api/queries/projects';
import type ProjectsHomePage from '../components/projects/ProjectsHome';
import type { AppUserLike, OpenThreadTarget, StartChat } from '../components/projects/workspace/types';
import type WorkspacePage from '../components/projects/workspace/ProjectWorkspacePage';
import { lazy } from '../utils/lazyWithReload';

// Both pages are lazy: most sessions never open a project, and the workspace
// pulls in the team chat, the document editor and the meeting views. The casts
// only restore the prop types the untyped reload-safe `lazy` drops.
const ProjectsHome = lazy(() => import('../components/projects/ProjectsHome')) as LazyExoticComponent<typeof ProjectsHomePage>;
const ProjectWorkspacePage = lazy(
    () => import('../components/projects/workspace/ProjectWorkspacePage'),
) as LazyExoticComponent<typeof WorkspacePage>;

/** Which projects page is on screen: `projectId` null is the list, `''` the
 *  create form, anything else one project, on `tab` and optionally `sub`. */
export interface ProjectsRoute {
    projectId: string | null;
    tab?: string | null;
    sub?: string | null;
}

export interface ProjectsViewProps {
    route: ProjectsRoute;
    projects: Project[];
    loading: boolean;
    error: string | null;
    user: AppUserLike | null;
    /** Navigate between projects pages (and write the URL). */
    onGoToProject: (projectId: string | null, tab?: string | null, sub?: string | null) => void;
    onClose: () => void;
    onSaved: (project: Project) => void;
    onDeleted: (projectId: string) => void;
    onOpenThread: (thread: OpenThreadTarget) => void;
    onNavigate: (page: string) => void;
    /** Returns false when the chat was refused; the composer keeps the message. */
    onStartChat: StartChat;
    /** Whether this person may use notebooks (plan, switch, permission). Absent: true. */
    notebooksEnabled?: boolean;
    /** The project search dialog; the hub owns the flag because the sidebar rail opens it. */
    searchOpen?: boolean;
    onSearchOpenChange?: (open: boolean) => void;
}

function PageFallback() {
    return (
        <div className="flex items-center justify-center w-full h-full">
            <div className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" />
        </div>
    );
}

/**
 * The projects pages inside the hub: the list of workspaces (ProjectsHome) or
 * one workspace (ProjectWorkspacePage). The URL is the source of truth for
 * which one, so every move between them goes through `onGoToProject`.
 */
export default function ProjectsView({
    route, projects, loading, error, user,
    onGoToProject, onClose, onSaved, onDeleted, onOpenThread, onNavigate, onStartChat, notebooksEnabled, searchOpen, onSearchOpenChange,
}: ProjectsViewProps) {
    const projectId = route.projectId;
    // Archived projects are not in the hub's list; the list page reads them for its "Archived" pill.
    const archived = useProjectsQuery('workspace', { enabled: projectId === null, includeArchived: true });
    return (
        <Suspense fallback={<PageFallback />}>
            {projectId !== null ? (
                <ProjectWorkspacePage
                    projectId={projectId}
                    initialTab={route.tab || undefined}
                    initialSub={route.sub ?? null}
                    onRouteChange={(tab, sub) => {
                        if (projectId) onGoToProject(projectId, tab, sub);
                    }}
                    user={user}
                    onClose={() => onGoToProject(null)}
                    onSaved={(saved) => {
                        onSaved(saved);
                        // A project that was just created leaves the create
                        // form for its own page.
                        if (projectId === '' && saved?.id) onGoToProject(saved.id);
                    }}
                    onDeleted={onDeleted}
                    onOpenThread={onOpenThread}
                    onNavigate={onNavigate}
                    onStartChat={onStartChat}
                    notebooksEnabled={notebooksEnabled}
                    searchOpen={searchOpen}
                    onSearchOpenChange={onSearchOpenChange}
                />
            ) : (
                <ProjectsHome
                    projects={projects}
                    archivedProjects={archived.data}
                    loading={loading}
                    error={error}
                    user={user}
                    onSelectProject={(p) => onGoToProject(p.id)}
                    onCreateProject={() => onGoToProject('')}
                    onClose={onClose}
                />
            )}
        </Suspense>
    );
}
