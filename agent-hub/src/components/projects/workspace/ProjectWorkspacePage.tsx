// The project workspace: one page per project, a rail of sections on the
// left, the open section on the right. `projectId === ''` is the create form.
//
// The shell owns the route inside the project (tab, the item open in it, and
// a one-shot intent from a quick action) and mirrors tab + item to the app
// through onRouteChange, so every view is a link. Everything else a section
// needs arrives as the common tab props (types.ts). The chat and content
// sections are separate chunks, loaded when first opened.

import { AlertTriangle, History, Package } from 'lucide-react';
import React, { Suspense, useCallback, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useProjectVisitQuery, type ChangeItemType } from '../../../api/queries/projectChanges';
import { useProjectChatsQuery } from '../../../api/queries/projectChats';
import { useProjectFilesQuery } from '../../../api/queries/projectContent';
import {
    useProjectMembersQuery, useProjectQuery, useProjectResourcesQuery, useProjectThreadsQuery,
    useSetProjectKind, type Project, type ProjectRole,
} from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import { lazy as lazyWithReload } from '../../../utils/lazyWithReload';
import ActivityTab from './ActivityTab';
import MembersTab from './MembersTab';
import OverviewTab from './OverviewTab';
import ProjectCreateForm from './ProjectCreateForm';
import { projectErrorText } from './projectErrorText';
import { ProjectLiveProvider } from './ProjectLiveContext';
import ProjectRail, { type RailCounts } from './ProjectRail';
import SettingsTab from './SettingsTab';
import { useChangeFeedLive, useMarkSeenWhenOpen, useProjectUnread } from './useProjectUnread';
import {
    contentIntentOf, normalizeWorkspaceTab, roleOfProject, toWorkspaceUser,
    type ChatsTabProps, type ContentTabProps, type ProjectWorkspacePageProps, type WorkspaceIntent, type WorkspaceTabId,
    type WorkspaceTabProps, type WorkspaceUser,
} from './types';
import { ErrorText, LoadingRow, Notice, PrimaryButton, SecondaryButton } from './workspaceUi';

/** A section in its own chunk, typed against the contract it must honour. */
function tabChunk<P>(importer: () => Promise<{ default: React.ComponentType<P> }>): React.ComponentType<P> {
    return lazyWithReload(importer) as unknown as React.ComponentType<P>;
}

const ProjectChatsTab = tabChunk<ChatsTabProps>(() => import('./chat/ProjectChatsTab'));
const DocumentsTab = tabChunk<ContentTabProps>(() => import('./content/DocumentsTab'));
const NotebooksTab = tabChunk<ContentTabProps>(() => import('./content/NotebooksTab'));
const MeetingsTab = tabChunk<ContentTabProps>(() => import('./content/MeetingsTab'));
const KnowledgeTab = tabChunk<ContentTabProps>(() => import('./content/KnowledgeTab'));

interface Route { tab: WorkspaceTabId; sub: string | null; intent: WorkspaceIntent | null }

/**
 * The route inside the project. Local state, so a click answers at once; the
 * app's URL follows through onRouteChange, and a URL change from outside
 * (back/forward) comes back in as new initialTab/initialSub.
 */
function useWorkspaceRoute(initialTab: string | null | undefined, initialSub: string | null | undefined, onRouteChange?: (tab: string, sub: string | null) => void) {
    const [route, setRoute] = useState<Route>(() => ({ tab: normalizeWorkspaceTab(initialTab), sub: initialSub ?? null, intent: null }));
    const [seen, setSeen] = useState({ initialTab, initialSub });
    if (seen.initialTab !== initialTab || seen.initialSub !== initialSub) {
        setSeen({ initialTab, initialSub });
        const tab = normalizeWorkspaceTab(initialTab);
        const sub = initialSub ?? null;
        if (tab !== route.tab || sub !== route.sub) setRoute({ tab, sub, intent: null });
    }
    const go = useCallback((tab: WorkspaceTabId, sub: string | null = null, intent: WorkspaceIntent | null = null) => {
        setRoute({ tab, sub, intent });
        onRouteChange?.(tab, sub);
    }, [onRouteChange]);
    return { ...route, go };
}

const lengthOf = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);

/** The rail without Notebooks, for a reader who may not use them. */
const NO_NOTEBOOKS: readonly WorkspaceTabId[] = Object.freeze(['notebooks']);

/** Rail counts. A count that is not known yet stays absent — never a guessed 0. */
function useRailCounts(projectId: string): RailCounts {
    const resources = useProjectResourcesQuery(projectId);
    const threads = useProjectThreadsQuery(projectId);
    const teamChats = useProjectChatsQuery(projectId);
    const files = useProjectFilesQuery(projectId);
    const members = useProjectMembersQuery(projectId);
    const kbs = lengthOf(resources.data?.knowledgeBases);
    return {
        chats: teamChats.data && threads.data ? teamChats.data.chats.length + threads.data.length : null,
        documents: lengthOf(resources.data?.documents),
        notebooks: lengthOf(resources.data?.notebooks),
        meetings: lengthOf(resources.data?.meetings),
        knowledge: files.data && kbs !== null ? files.data.files.length + kbs : null,
        members: members.data ? members.data.members.length + 1 : null,
    };
}

function KindNotice({ project, role, onNavigate }: { project: Project; role: ProjectRole; onNavigate: (page: string) => void }) {
    const { t } = useTranslation();
    const setKind = useSetProjectKind(project.id);
    if (project.kind === 'solution') {
        // The upgrade sorted this project as a Solution; its owner may keep
        // it as a project instead, once (the server refuses while it holds
        // automations, apps or tables, and says so).
        const correctable = project.kindGuessed === true && role === 'owner';
        return (
            <Notice
                icon={Package}
                testId="project-kind-solution"
                action={(
                    <div className="flex gap-2">
                        {correctable && (
                            <PrimaryButton onClick={() => setKind.mutate('workspace')} busy={setKind.isPending} data-testid="project-keep-kind">
                                {t('project_home.kind.keep', 'Keep as project')}
                            </PrimaryButton>
                        )}
                        <SecondaryButton onClick={() => onNavigate(`studio/solutions/${project.id}`)}>{t('project_home.kind.open_studio', 'Open in Studio')}</SecondaryButton>
                    </div>
                )}
            >
                <span>
                    {correctable
                        ? t('project_home.kind.solution_guessed', 'When projects and Studio Solutions were separated, this was sorted as a Studio Solution. If your team works in it as a project, keep it as a project.')
                        : t('project_home.kind.solution', 'This is a Studio Solution. Its automations, apps and tables are managed in Studio; chats cannot be filed in it.')}
                </span>
                <ErrorText>{setKind.error ? projectErrorText(t, setKind.error) : null}</ErrorText>
            </Notice>
        );
    }
    if (project.kind !== null) return null;
    return (
        <Notice
            icon={History}
            testId="project-kind-legacy"
            action={role === 'owner' ? (
                <PrimaryButton onClick={() => setKind.mutate('workspace')} busy={setKind.isPending} data-testid="project-keep-kind">
                    {t('project_home.kind.keep', 'Keep as project')}
                </PrimaryButton>
            ) : undefined}
        >
            <span>
                {t('project_home.kind.legacy', 'This project was made before projects and Studio Solutions were separated, so it also shows up under Studio → Solutions.')}
                {role !== 'owner' && ` ${t('project_home.kind.legacy_ask_owner', 'The owner can keep it as a project.')}`}
            </span>
            <ErrorText>{setKind.error ? projectErrorText(t, setKind.error) : null}</ErrorText>
        </Notice>
    );
}

function ProjectUnavailable({ error, onBack, onRetry }: { error: Error; onBack: () => void; onRetry: () => void }) {
    const { t } = useTranslation();
    const gone = error instanceof ApiError && (error.status === 404 || error.status === 403);
    return (
        <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center bg-[var(--bg-primary)]" role="alert" data-testid="project-unavailable">
            <AlertTriangle className="w-6 h-6 text-[var(--warning)]" aria-hidden="true" />
            <p className="text-[15px] font-semibold text-[var(--text-primary)] m-0">
                {gone
                    ? t('project_home.unavailable.gone', 'This project does not exist, or you no longer have access to it.')
                    : t('project_home.unavailable.failed', 'Could not load this project.')}
            </p>
            <div className="flex gap-2">
                <SecondaryButton onClick={onBack}>{t('project_home.all_projects', 'All projects')}</SecondaryButton>
                {!gone && <PrimaryButton onClick={onRetry}>{t('project_home.retry', 'Try again')}</PrimaryButton>}
            </div>
        </div>
    );
}

interface WorkspaceProps extends Omit<ProjectWorkspacePageProps, 'projectId' | 'user'> {
    projectId: string;
    currentUser: WorkspaceUser | null;
}

function TabContent({ route, project, role, props }: {
    route: ReturnType<typeof useWorkspaceRoute>;
    project: Project;
    role: ProjectRole;
    props: WorkspaceProps;
}) {
    const { projectId, currentUser, onNavigate, onOpenThread, onStartChat, onDeleted } = props;
    const common: WorkspaceTabProps = {
        projectId, project, role, currentUser, onNavigate,
        notebooksEnabled: props.notebooksEnabled !== false,
        sub: route.sub,
        onOpenSub: (sub) => route.go(route.tab, sub),
        intent: route.intent,
    };
    const content: ContentTabProps = { ...common, intent: contentIntentOf(route.intent) };
    const onLeft = () => onDeleted?.(projectId);
    switch (route.tab) {
        case 'chats': return <ProjectChatsTab {...common} onOpenThread={onOpenThread} onStartChat={onStartChat} />;
        case 'documents': return <DocumentsTab {...content} />;
        case 'notebooks': return <NotebooksTab {...content} />;
        case 'meetings': return <MeetingsTab {...content} />;
        case 'knowledge': return <KnowledgeTab {...content} />;
        case 'members': return <MembersTab {...common} onLeft={onLeft} />;
        case 'activity': return <ActivityTab {...common} />;
        case 'settings': return <SettingsTab {...common} onDeleted={onDeleted} onLeft={onLeft} />;
        default: return <OverviewTab {...common} onOpenTab={route.go} onStartChat={onStartChat} onOpenThread={onOpenThread} />;
    }
}

/** The item open inside a tab, as the change feed names it; null for anything else. */
function openItemOf(tab: WorkspaceTabId, sub: string | null): { type: ChangeItemType; id: string } | null {
    if (!sub) return null;
    if (tab === 'documents') return { type: 'document', id: sub };
    if (tab === 'meetings') return { type: 'meeting', id: sub };
    return null;
}

/**
 * The reader's side of "what changed": the visit (posted on open and while
 * the page stays open), the unread marks, fresh marks when somebody else
 * changes content, and an item marked seen once it has been open a moment.
 */
function useReadState(projectId: string, currentUserId: string | null | undefined, tab: WorkspaceTabId, sub: string | null) {
    useProjectVisitQuery(projectId);
    useChangeFeedLive(projectId, currentUserId);
    const unread = useProjectUnread(projectId);
    const open = openItemOf(tab, sub);
    useMarkSeenWhenOpen(unread, open ? { type: open.type, id: open.id } : null);
    return unread;
}

function Workspace(props: WorkspaceProps) {
    const { t } = useTranslation();
    const { projectId, initialTab, initialSub, onRouteChange, currentUser, onClose, onNavigate } = props;
    const projectQuery = useProjectQuery(projectId);
    const route = useWorkspaceRoute(initialTab, initialSub, onRouteChange);
    const counts = useRailCounts(projectId);
    const unread = useReadState(projectId, currentUser?.id, route.tab, route.sub);

    if (projectQuery.isPending) return <LoadingRow label={t('project_home.loading_project', 'Loading project…')} />;
    if (projectQuery.isError) return <ProjectUnavailable error={projectQuery.error} onBack={onClose} onRetry={() => projectQuery.refetch()} />;
    const project = projectQuery.data;
    const role = roleOfProject(project);

    return (
        <div className="h-full flex min-h-0 bg-[var(--bg-primary)]" data-testid="project-workspace">
            <ProjectRail
                project={project}
                role={role}
                activeTab={route.tab}
                counts={counts}
                unread={unread.tabs}
                onSelect={(tab) => route.go(tab)}
                onBack={onClose}
                currentUserId={currentUser?.id}
                hidden={props.notebooksEnabled === false ? NO_NOTEBOOKS : undefined}
            />
            <main className="flex-1 min-w-0 flex flex-col min-h-0">
                {(project.kind === null || project.kind === 'solution') && (
                    <div className="px-4 pt-3">
                        <KindNotice project={project} role={role} onNavigate={onNavigate} />
                    </div>
                )}
                <div className="flex-1 min-h-0">
                    <Suspense fallback={<LoadingRow label={t('project_home.loading', 'Loading…')} />}>
                        <TabContent key={route.tab} route={route} project={project} role={role} props={props} />
                    </Suspense>
                </div>
            </main>
        </div>
    );
}

export default function ProjectWorkspacePage(props: ProjectWorkspacePageProps) {
    const { projectId, user, onClose, onSaved } = props;
    const currentUser = toWorkspaceUser(user);
    if (!projectId) return <ProjectCreateForm onCancel={onClose} onCreated={onSaved} />;
    // Keyed by project: moving to another project from the sidebar starts
    // every tab afresh. Without it the same composer (its draft, its "share
    // with members" switch) and any open history drawer stayed on screen and
    // acted on the new project.
    return (
        <ProjectLiveProvider projectId={projectId} currentUserId={currentUser?.id}>
            <Workspace key={projectId} {...props} projectId={projectId} currentUser={currentUser} />
        </ProjectLiveProvider>
    );
}
