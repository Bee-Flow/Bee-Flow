import { registerNavigationGuard } from '../../../utils/unsavedNavigation';
// The project workspace: one page per project, a rail of sections on the
// left, the open section on the right. `projectId === ''` is the create form.
//
// The shell owns the route inside the project (tab, the item open in it, and
// a one-shot intent from a quick action) and mirrors tab + item to the app
// through onRouteChange, so every view is a link. Everything else a section
// needs arrives as the common tab props (types.ts). The chat and content
// sections are separate chunks, loaded when first opened.

import { AlertTriangle, History, Package } from 'lucide-react';
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../../api/client';
import { useProjectVisitQuery, type ChangeItemType } from '../../../api/queries/projectChanges';
import {
    useProjectQuery, useSetProjectKind, type Project, type ProjectRole,
} from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import { lazy as lazyWithReload } from '../../../utils/lazyWithReload';
import SegmentedControl from '../../shared/SegmentedControl';
import useConfirm from '../../shared/useConfirm';
import ActivityTab from './ActivityTab';
import ArchivedBand from './ArchivedBand';
import { useProjectLive, type ViewTarget } from './ProjectLiveContext';
import ConnectionBand from './ConnectionBand';
import MembersTab from './MembersTab';
import OverviewTab from './OverviewTab';
import ProjectCreateForm from './ProjectCreateForm';
import ProjectSearchPanel from './ProjectSearchPanel';
import { projectErrorText } from './projectErrorText';
import { projectIcon, projectTileStyle } from './projectVisuals';
import TasksTab from './tasks/TasksTab';
import SettingsTab from './SettingsTab';
import { hiddenTabsFor, useRailCounts, useRailGroups } from './useProjectRailData';
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

function TabContent({ route, project, role, props, onSettingsDirty }: {
    route: ReturnType<typeof useWorkspaceRoute>;
    project: Project;
    role: ProjectRole;
    props: WorkspaceProps;
    onSettingsDirty: (dirty: boolean) => void;
}) {
    const { projectId, currentUser, onNavigate, onOpenThread, onStartChat, onDeleted } = props;
    // An archived project is read-only: the content tabs get a viewer's role (so every composer and
    // action hides itself the way it does for a viewer); members and settings keep the real role so
    // the owner can still restore, transfer or delete.
    const readOnly = !!project.archivedAt;
    const tabRole: ProjectRole = readOnly && route.tab !== 'members' && route.tab !== 'settings' ? 'viewer' : role;
    const common: WorkspaceTabProps = {
        projectId, project, role: tabRole, readOnly, currentUser, onNavigate,
        notebooksEnabled: props.notebooksEnabled !== false,
        sub: route.sub,
        onOpenSub: (sub) => route.go(route.tab, sub),
        onOpenTab: route.go,
        intent: route.intent,
    };
    const content: ContentTabProps = { ...common, intent: contentIntentOf(route.intent) };
    const onLeft = () => onDeleted?.(projectId);
    switch (route.tab) {
        case 'chats': return <ProjectChatsTab {...common} onOpenThread={onOpenThread} onStartChat={onStartChat} />;
        case 'tasks': return <TasksTab {...common} />;
        case 'documents': return <DocumentsTab {...content} />;
        case 'notebooks': return <NotebooksTab {...content} />;
        case 'meetings': return <MeetingsTab {...content} />;
        case 'knowledge': return <KnowledgeTab {...content} />;
        case 'members': return <MembersTab {...common} onLeft={onLeft} />;
        case 'activity': return <ActivityTab {...common} onOpenThread={onOpenThread} />;
        case 'settings': return <SettingsTab {...common} onDeleted={onDeleted} onLeft={onLeft} onDirtyChange={onSettingsDirty} />;
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

const VIEW_TYPE_OF_TAB: Partial<Record<WorkspaceTabId, ViewTarget['type']>> = {
    documents: 'document', notebooks: 'notebook', meetings: 'meeting', tasks: 'task', chats: 'chat',
};

/** The item open inside a tab, as presence names it; null for anything else. */
export function viewTargetOf(tab: WorkspaceTabId, sub: string | null): ViewTarget | null {
    const type = VIEW_TYPE_OF_TAB[tab];
    return type && sub ? { type, id: sub } : null;
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
    // Colleagues see which item this tab has open: the presence beat carries it.
    const { setViewing } = useProjectLive();
    const viewType = viewTargetOf(tab, sub)?.type;
    const viewId = viewTargetOf(tab, sub)?.id;
    useEffect(() => {
        setViewing(viewType && viewId ? { type: viewType, id: viewId } : null);
        return () => setViewing(null);
    }, [setViewing, viewType, viewId]);
    useMarkSeenWhenOpen(unread, open ? { type: open.type, id: open.id } : null);
    return unread;
}

function Workspace(props: WorkspaceProps) {
    const { t } = useTranslation();
    const { projectId, initialTab, initialSub, onRouteChange, currentUser, onClose, onNavigate } = props;
    const projectQuery = useProjectQuery(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const settingsDirty = useRef(false);
    const onSettingsDirty = useCallback((dirty: boolean) => { settingsDirty.current = dirty; }, []);
    const plainRoute = useWorkspaceRoute(initialTab, initialSub, onRouteChange);
    const routeNow = useRef(plainRoute);
    routeNow.current = plainRoute;
    // One question for every way out of unsaved Settings: the rail, the app's
    // navigation guard, the back button. Resolves true when the reader leaves.
    const leave = useCallback((): boolean | Promise<boolean> => {
        if (!settingsDirty.current) return true;
        return confirm({
            title: t('project_home.settings.leave_title', 'Leave without saving?'),
            description: t('project_home.settings.leave_body', 'Your changes to the settings have not been saved and will be lost.'),
            confirmLabel: t('project_home.settings.leave_confirm', 'Leave without saving'),
            cancelLabel: t('project_home.settings.leave_stay', 'Keep editing'),
            destructive: true,
        }).then((ok: boolean) => {
            if (ok) settingsDirty.current = false;
            return ok;
        });
    }, [confirm, t]);
    // A click on the section that is already open never prompts.
    const go = useCallback((tab: WorkspaceTabId, sub: string | null = null, intent: WorkspaceIntent | null = null) => {
        if (tab === routeNow.current.tab || !settingsDirty.current) { routeNow.current.go(tab, sub, intent); return; }
        void Promise.resolve(leave()).then((ok) => { if (ok) routeNow.current.go(tab, sub, intent); });
    }, [leave]);
    const onDeleted = props.onDeleted;
    const deleted = useCallback((id: string) => {
        // The project is gone: nothing is left to protect, and the host's own
        // guard must not ask about it.
        settingsDirty.current = false;
        onDeleted?.(id);
    }, [onDeleted]);
    useEffect(() => registerNavigationGuard(leave), [leave]);
    useEffect(() => {
        // Keep the form mounted and restore its URL if a browser traversal is cancelled.
        const location = window.location.href;
        const state = window.history.state;
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (settingsDirty.current) { event.preventDefault(); event.returnValue = ''; }
        };
        const pop = (event: PopStateEvent) => {
            if (!settingsDirty.current) return;
            event.stopImmediatePropagation();
            window.history.pushState(state, '', location);
            void Promise.resolve(leave()).then((ok) => { if (ok) window.history.back(); });
        };
        window.addEventListener('beforeunload', beforeUnload);
        window.addEventListener('popstate', pop, true);
        return () => {
            window.removeEventListener('beforeunload', beforeUnload);
            window.removeEventListener('popstate', pop, true);
        };
    }, [plainRoute.tab, plainRoute.sub, leave]);
    const route = { ...plainRoute, go };
    const counts = useRailCounts(projectId);
    const unread = useReadState(projectId, currentUser?.id, route.tab, route.sub);
    const groups = useRailGroups(hiddenTabsFor(projectQuery.data ?? null, props.notebooksEnabled !== false));

    if (projectQuery.isPending) return <LoadingRow label={t('project_home.loading_project', 'Loading project…')} />;
    if (projectQuery.isError) return <ProjectUnavailable error={projectQuery.error} onBack={onClose} onRetry={() => projectQuery.refetch()} />;
    const project = projectQuery.data;
    const role = roleOfProject(project);

    return (
        <div className="h-full flex min-h-0 bg-[var(--bg-primary)]" data-testid="project-workspace">
            <main className="flex-1 min-w-0 flex flex-col min-h-0">
                <div className="md:hidden flex items-center gap-2 p-2 border-b border-[var(--border-default)] overflow-x-auto">
                    <SecondaryButton onClick={() => { void Promise.resolve(leave()).then((ok) => { if (ok) onClose(); }); }}>{t('project_home.all_projects', 'All projects')}</SecondaryButton>
                    <span className="flex items-center gap-1.5 min-w-0 max-w-[40%] shrink-0" data-testid="project-bar-name">
                        <span className="flex items-center justify-center shrink-0" style={projectTileStyle(project.color, 20)} aria-hidden="true">{projectIcon(project.icon)}</span>
                        <span className="truncate text-sm font-medium text-[var(--text-primary)]">{project.name}</span>
                    </span>
                    <SegmentedControl
                        size="sm"
                        ariaLabel={t('project_home.rail.label', 'Project sections')}
                        value={route.tab}
                        onChange={(tab) => route.go(tab)}
                        options={groups.flatMap((g) => g.items.map((item) => ({
                            value: item.id,
                            label: item.label,
                            badge: unread.tabs[item.id] && item.id !== route.tab ? { count: '•', tone: 'neutral' as const } : (counts[item.id] ?? null),
                        })))}
                    />
                </div>
                {/* An open team chat shows its own band above its composer. */}
                {!(route.tab === 'chats' && route.sub) && <ConnectionBand className="px-4 pt-3" />}
                {(project.kind === null || project.kind === 'solution') && (
                    <div className="px-4 pt-3">
                        <KindNotice project={project} role={role} onNavigate={onNavigate} />
                    </div>
                )}
                {project.archivedAt && (
                    <div className="px-4 pt-3">
                        <ArchivedBand project={project} isOwner={role === 'owner'} />
                    </div>
                )}
                <div className="flex-1 min-h-0">
                    <Suspense fallback={<LoadingRow label={t('project_home.loading', 'Loading…')} />}>
                        <TabContent key={route.tab} route={route} project={project} role={role} props={{ ...props, onDeleted: deleted }} onSettingsDirty={onSettingsDirty} />
                    </Suspense>
                </div>
            </main>
            {confirmDialog}
            <ProjectSearchPanel projectId={projectId} role={role} open={!!props.searchOpen} onClose={() => props.onSearchOpenChange?.(false)} onOpenTab={route.go} onOpenThread={props.onOpenThread} />
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
    // acted on the new project. The live feed (presence, unread refresh) is
    // provided by the hub, around the sidebar AND this page, so the rail
    // shares it.
    return <Workspace key={projectId} {...props} projectId={projectId} currentUser={currentUser} />;
}
