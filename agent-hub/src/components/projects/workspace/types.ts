// The contract between the project workspace shell and the tabs it hosts.
//
// The shell (ProjectWorkspacePage) owns the route — which tab, which item
// inside it — and hands every tab the same props, so a tab written by another
// team plugs in without knowing how the page around it is wired. The app
// (AgentHub) owns everything outside the page: opening a chat, the URL, the
// project list.

import type { Project, ProjectRole } from '../../../api/queries/projects';

export type WorkspaceTabId =
    | 'overview'
    | 'chats'
    | 'documents'
    | 'notebooks'
    | 'meetings'
    | 'knowledge'
    | 'members'
    | 'activity'
    | 'settings';

export const WORKSPACE_TABS: readonly WorkspaceTabId[] = Object.freeze([
    'overview', 'chats', 'documents', 'notebooks', 'meetings', 'knowledge', 'members', 'activity', 'settings',
]);

/** Tab ids of the previous project page, so an old link still lands somewhere sensible. */
const LEGACY_TABS: Readonly<Record<string, WorkspaceTabId>> = Object.freeze({
    general: 'settings',
    threads: 'chats',
    resources: 'overview',
    memory: 'knowledge',
    danger: 'settings',
});

/** A URL segment → a tab the workspace has. Unknown or empty → the overview. */
export function normalizeWorkspaceTab(raw?: string | null): WorkspaceTabId {
    if (!raw) return 'overview';
    if ((WORKSPACE_TABS as readonly string[]).includes(raw)) return raw as WorkspaceTabId;
    return LEGACY_TABS[raw] ?? 'overview';
}

/** What the app needs to start a chat from inside a project. */
export interface StartChatOptions {
    project: Project;
    message: string;
    /** Set for an agent chat; absent or null for a chat with the AI assistant. */
    agentId?: string | null;
    /** Share the new conversation with the project's members once it exists. */
    share?: boolean;
}

/**
 * Starts a chat from inside a project. `false` when the app refused to start
 * it (an agent it does not know, nothing to send): the caller keeps the
 * message where it was, so nothing the person typed is lost.
 */
export type StartChat = (opts: StartChatOptions) => boolean;

/** An AI chat (direct or agent) the app should open. */
export interface OpenThreadTarget {
    id: string;
    type: 'direct' | 'agent';
    agentId?: string | null;
}

export interface WorkspaceUser {
    id: string;
    name?: string;
    email?: string;
}

/**
 * A one-shot request a quick action carries into a tab: "create" (open the
 * new-item form), "add" (pick an existing item), "capture" (record or upload
 * a meeting), "upload" (open the file chooser), "invite" (open the invite
 * form). A tab that does not know the intent ignores it.
 */
export type ContentIntent = 'create' | 'add' | 'capture' | 'upload';
export type WorkspaceIntent = ContentIntent | 'invite';

/** Props every workspace tab receives. */
export interface WorkspaceTabProps {
    projectId: string;
    project: Project;
    role: ProjectRole;
    currentUser: WorkspaceUser | null;
    /** The item open inside the tab (a team chat, a document, a meeting), or null. */
    sub: string | null;
    onOpenSub: (sub: string | null) => void;
    /** The app's page navigation, e.g. `'notebooks/<id>'`. */
    onNavigate: (page: string) => void;
    intent?: WorkspaceIntent | null;
    /**
     * Whether the reader may use notebooks at all (plan, operator switch,
     * the `use_notebooks` permission, Simple Mode). False: no way to make or
     * open one here, since the notebook editor would refuse it. Absent: true.
     */
    notebooksEnabled?: boolean;
}

/** A content section (documents, notebooks, meetings, knowledge): only the content intents reach it. */
export interface ContentTabProps extends Omit<WorkspaceTabProps, 'intent'> {
    intent?: ContentIntent | null;
}

export function contentIntentOf(intent: WorkspaceIntent | null | undefined): ContentIntent | null {
    return intent && intent !== 'invite' ? intent : null;
}

export interface ChatsTabProps extends WorkspaceTabProps {
    onOpenThread: (thread: OpenThreadTarget) => void;
    onStartChat: StartChat;
}

/** The signed-in user as the app hands it over. */
export interface AppUserLike {
    id?: string;
    name?: string;
    displayName?: string;
    username?: string;
    email?: string;
}

export interface ProjectWorkspacePageProps {
    /** `''` (or null) opens the create form. */
    projectId: string | null;
    initialTab?: string | null;
    initialSub?: string | null;
    /** The route inside the project changed; the app mirrors it into the URL. */
    onRouteChange?: (tab: string, sub: string | null) => void;
    user: AppUserLike | null;
    onClose: () => void;
    onSaved?: (project: Project) => void;
    /** The project is gone for this user: deleted, or they left it. */
    onDeleted?: (projectId: string) => void;
    onOpenThread: (thread: OpenThreadTarget) => void;
    onNavigate: (page: string) => void;
    onStartChat: StartChat;
    /** The app's answer to "may this person use notebooks" (AgentHub). Absent: true. */
    notebooksEnabled?: boolean;
}

export function toWorkspaceUser(user: AppUserLike | null | undefined): WorkspaceUser | null {
    if (!user?.id) return null;
    return { id: user.id, name: user.displayName || user.name || user.username, email: user.email };
}

/**
 * The caller's role. The detail endpoint says `role`, the list says
 * `permission`. When neither is known the answer is the LEAST privilege:
 * guessing "owner" would show controls the server then refuses.
 */
export function roleOfProject(project: Project | null | undefined): ProjectRole {
    const role = project?.role || project?.permission;
    return role === 'owner' || role === 'editor' ? role : 'viewer';
}

export const canEditProject = (role: ProjectRole): boolean => role === 'owner' || role === 'editor';
