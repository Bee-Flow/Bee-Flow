/** A collaborative workspace, or a Studio Solution. `null` is a project from
 *  before the split that nobody has classified yet; it shows in both places. */
export type ProjectKind = 'workspace' | 'solution';

export type ProjectRole = 'owner' | 'editor' | 'viewer';

export interface ProjectForm {
    name?: string;
    description?: string;
    customInstructions?: string;
    color?: string;
    icon?: string;
    knowledgeBaseIds?: string[];
    extractMemories?: boolean;
    kind?: ProjectKind;
    /** Owner only. */
    editorsCanInvite?: boolean;
    /** I muted this project's notifications (when the server says so; there is no other read for it). */
    muted?: boolean;
}

export interface ProjectShare {
    /** Share row id: the `:memberId` in the member routes. */
    id: string;
    sharedWithType: 'user' | 'group';
    sharedWithId: string;
    permission: 'editor' | 'viewer';
    createdAt?: string;
}

/** A member the way every viewer of the project sees them: a display name, never an e-mail address. */
interface ProjectPerson {
    name?: string;
    avatar?: string;
    avatarType?: 'emoji' | 'image' | 'url';
    /** The colour the project gave this person; absent for the automatic one. */
    color?: string;
}

export interface ProjectMembers {
    ownerId: string;
    /** The organisation of the project, '' for none: only its own people and groups can be invited. */
    organizationId?: string;
    members: ProjectShare[];
    /** Display names for the owner and user members, keyed by user id. */
    people: Record<string, ProjectPerson>;
    /** Display names for group members, keyed by group id. */
    groups: Record<string, { name?: string }>;
}

export interface ProjectActivityItem {
    id: string;
    action: string;
    actorId?: string;
    targetType?: string | null;
    targetId?: string | null;
    details?: Record<string, unknown>;
    createdAt: string;
}

/** One section of GET /:id/resources. `null` means "could not be read", never
 *  "empty": a failed store must not render as nothing filed. */
type ResourceSection = Array<Record<string, any>> | null;

export interface ProjectResources {
    role?: ProjectRole;
    kind?: ProjectKind | null;
    notebooks?: ResourceSection;
    documents?: ResourceSection;
    meetings?: ResourceSection;
    knowledgeBases?: ResourceSection;
    [section: string]: unknown;
}

export interface ProjectThread {
    id: string;
    type: 'direct' | 'agent';
    /** The agent an agent chat is opened through; null for a direct chat. */
    agentId?: string | null;
    ownerId: string;
    title?: string;
    updatedAt?: string;
    createdAt?: string;
}

export interface MyProjectChat {
    id: string;
    type: 'direct' | 'agent';
    agentId?: string | null;
    title?: string;
    updatedAt?: string;
    shared: boolean;
}

export interface InviteForm { sharedWithType: 'user' | 'group'; sharedWithId: string; permission: 'editor' | 'viewer' }

/** A person or group the invite picker can offer. The server never sends an e-mail address. */
export interface ProjectPrincipals {
    users: Array<{ id: string; name: string; avatar?: { type?: string; value?: string } | null }>;
    groups: Array<{ id: string; name: string; memberCount: number }>;
}

export interface TransferOwnerForm { toUserId: string; keepMeAs: 'editor' | 'viewer' | 'none'; expectedOwnerId?: string }
