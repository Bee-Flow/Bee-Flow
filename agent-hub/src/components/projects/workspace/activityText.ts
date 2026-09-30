// One sentence per activity entry, for every kind the project feed writes.
// Every sentence is a key in the `project_home` namespace; the English beside
// it is only the fallback while the catalogue loads.

import type { ProjectActivityItem } from '../../../api/queries/projects';

type TFn = (key: string, fallback: string, params?: Record<string, unknown>) => string;

export type ActivityCategory = 'chats' | 'content' | 'people' | 'project';

/**
 * An activity entry as the feed and the change log send it. The change log
 * adds the item's title, read at request time with the reader's access, and
 * who acted when it was not a person (`actorKind` 'ai' or 'system').
 */
export type ActivityEntry = ProjectActivityItem & {
    title?: string | null;
    actorKind?: 'user' | 'ai' | 'system' | string;
};

export interface ActivityNames {
    /** The display name of a user id, or null when it is not a current member. */
    person: (id: string | null | undefined) => string | null;
    group: (id: string | null | undefined) => string | null;
    currentUserId?: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function activityCategory(action: string): ActivityCategory {
    if (action.startsWith('member_')) return 'people';
    if (action.startsWith('thread_') || action.startsWith('conversation_') || action.startsWith('chat.')) return 'chats';
    if (action.startsWith('resource_') || action.startsWith('kb_') || action.startsWith('file.')
        || action.startsWith('content.') || action.startsWith('doc.') || action.startsWith('comment.')) return 'content';
    return 'project';
}

/** Is this entry a change to a notebook, document or meeting (the "Changes only" view)? */
export function isContentChange(action: string): boolean {
    return action.startsWith('content.') || action === 'doc.edited' || action === 'doc.restored';
}

function actorOf(item: ActivityEntry, names: ActivityNames, t: TFn): string {
    if (item.actorId && item.actorId === names.currentUserId) return t('project_home.activity.you', 'You');
    if (!item.actorId && item.actorKind === 'ai') return t('project_home.activity.the_ai', 'The AI');
    return names.person(item.actorId) || t('project_home.activity.someone', 'Someone');
}

function subjectOf(item: ProjectActivityItem, names: ActivityNames, t: TFn): string {
    if (item.targetType === 'group') return names.group(item.targetId) || t('project_home.activity.a_group', 'a group');
    if (item.targetId && item.targetId === names.currentUserId) return t('project_home.activity.you_lower', 'you');
    return names.person(item.targetId) || t('project_home.activity.a_person', 'someone');
}

function roleWord(role: unknown, t: TFn): string {
    if (role === 'editor' || role === 'edit') return t('project_home.activity.role_editor', 'editor');
    if (role === 'owner') return t('project_home.activity.role_owner', 'owner');
    return t('project_home.activity.role_viewer', 'viewer');
}

/** "a document", "a meeting", … — what a resource event added or removed. */
function thingOf(targetType: string | null | undefined, t: TFn): string {
    switch (targetType) {
        case 'document': return t('project_home.activity.thing_document', 'a document');
        case 'meeting': return t('project_home.activity.thing_meeting', 'a meeting');
        case 'notebook': return t('project_home.activity.thing_notebook', 'a notebook');
        case 'knowledge_base': return t('project_home.activity.thing_kb', 'a knowledge base');
        case 'automation': return t('project_home.activity.thing_automation', 'an automation');
        case 'app': return t('project_home.activity.thing_app', 'an app');
        case 'webpage': return t('project_home.activity.thing_webpage', 'a web page');
        case 'datatable': return t('project_home.activity.thing_table', 'a table');
        case 'agent': return t('project_home.activity.thing_agent', 'an agent');
        default: return t('project_home.activity.thing_other', 'an item');
    }
}

interface Ctx { item: ActivityEntry; actor: string; names: ActivityNames; t: TFn; d: Record<string, unknown> }

/** The item a content entry is about: its title in quotes when known, else "a document". */
function itemOf({ item, d, t }: Ctx): string {
    const title = str(item.title);
    if (title) return t('project_home.activity.quoted', '“{title}”', { title });
    const resource = (d.resource && typeof d.resource === 'object' ? d.resource : {}) as Record<string, unknown>;
    const type = str(d.itemType) || str(resource.kind) || item.targetType;
    return thingOf(type, t);
}

/** "Anna edited “Launch brief”", with the AI's part said when it helped. */
function editedSentence(c: Ctx): string {
    const { actor, d, t } = c;
    const thing = itemOf(c);
    if (d.aiAssisted === true && c.item.actorId) return t('project_home.activity.content_edited_ai', '{actor} edited {thing} with AI', { actor, thing });
    return t('project_home.activity.content_edited', '{actor} edited {thing}', { actor, thing });
}

/**
 * A comment entry: the thread is the target, the notebook or document it is
 * on travels in the details (`itemType` in the activity row, `targetType` in
 * a live event). Never the comment's text: it is sealed with the project key.
 */
function commentSentence(key: string, fallback: string) {
    return (c: Ctx): string => {
        const type = str(c.d.itemType) || str(c.d.targetType);
        return c.t(key, fallback, { actor: c.actor, thing: thingOf(type, c.t) });
    };
}

function automationSentence({ item, d, t }: Ctx): string {
    const title = str(d.automationTitle) || t('project_home.activity.an_automation', 'An automation');
    if (item.action === 'automation.run.failed') return t('project_home.activity.run_failed', '{title} failed', { title });
    if (item.action === 'automation.run.finished') return t('project_home.activity.run_finished', '{title} finished', { title });
    return t('project_home.activity.run_started', '{title} started', { title });
}

const SENTENCES: Record<string, (c: Ctx) => string> = {
    project_created: ({ actor, t }) => t('project_home.activity.project_created', '{actor} created the project', { actor }),
    project_updated: ({ actor, t }) => t('project_home.activity.project_updated', '{actor} updated the project settings', { actor }),
    instructions_updated: ({ actor, t }) => t('project_home.activity.instructions_updated', '{actor} updated the instructions for the AI', { actor }),
    kind_set: ({ actor, d, t }) => (d.kind === 'solution'
        ? t('project_home.activity.kind_solution', '{actor} marked this as a Studio Solution', { actor })
        : t('project_home.activity.kind_workspace', '{actor} kept this as a project', { actor })),
    member_added: ({ item, actor, names, d, t }) => t('project_home.activity.member_added', '{actor} invited {subject} as {role}', {
        actor, subject: subjectOf(item, names, t), role: roleWord(d.role, t),
    }),
    member_removed: ({ item, actor, names, d, t }) => (d.selfLeave
        ? t('project_home.activity.member_left', '{actor} left the project', { actor })
        : t('project_home.activity.member_removed', '{actor} removed {subject}', { actor, subject: subjectOf(item, names, t) })),
    member_role_changed: ({ item, actor, names, d, t }) => t('project_home.activity.member_role', '{actor} changed the role of {subject} to {role}', {
        actor, subject: subjectOf(item, names, t), role: roleWord(d.to, t),
    }),
    kb_added: ({ actor, t }) => t('project_home.activity.kb_added', '{actor} linked a knowledge base', { actor }),
    kb_removed: ({ actor, t }) => t('project_home.activity.kb_removed', '{actor} unlinked a knowledge base', { actor }),
    thread_shared: ({ actor, t }) => t('project_home.activity.thread_shared', '{actor} shared an AI chat with the project', { actor }),
    thread_unshared: ({ actor, t }) => t('project_home.activity.thread_unshared', '{actor} made an AI chat private again', { actor }),
    conversation_assigned: ({ actor, t }) => t('project_home.activity.chat_filed', '{actor} filed a chat in the project', { actor }),
    conversation_unassigned: ({ actor, t }) => t('project_home.activity.chat_unfiled', '{actor} moved a chat out of the project', { actor }),
    resource_added: ({ item, actor, t }) => t('project_home.activity.resource_added', '{actor} added {thing}', { actor, thing: thingOf(item.targetType, t) }),
    resource_removed: ({ item, actor, t }) => t('project_home.activity.resource_removed', '{actor} removed {thing} from the project', { actor, thing: thingOf(item.targetType, t) }),
    'file.added': ({ actor, d, t }) => (str(d.name)
        ? t('project_home.activity.file_added_named', '{actor} uploaded “{name}”', { actor, name: str(d.name) })
        : t('project_home.activity.file_added', '{actor} uploaded a file', { actor })),
    'file.removed': ({ actor, d, t }) => (str(d.name)
        ? t('project_home.activity.file_removed_named', '{actor} deleted the file “{name}”', { actor, name: str(d.name) })
        : t('project_home.activity.file_removed', '{actor} deleted a file', { actor })),
    // A team chat's title is encrypted with the project key, so the activity
    // row carries only its id (targetType 'project_chat'), never the title.
    'chat.created': ({ actor, t }) => t('project_home.activity.team_chat', '{actor} started a team chat', { actor }),
    'task.created': ({ actor, t }) => t('project_home.activity.task_created', '{actor} added a task', { actor }),
    'task.deleted': ({ actor, t }) => t('project_home.activity.task_deleted', '{actor} deleted a task', { actor }),
    'chat.deleted': ({ actor, t }) => t('project_home.activity.team_chat_deleted', '{actor} deleted a team chat', { actor }),
    'approval.requested': ({ t }) => t('project_home.activity.approval_requested', 'An approval was requested'),
    'approval.decided': ({ actor, t }) => t('project_home.activity.approval_decided', '{actor} decided on an approval', { actor }),
    'automation.run.started': automationSentence,
    'automation.run.finished': automationSentence,
    'automation.run.failed': automationSentence,
    'blueprint.published': ({ actor, t }) => t('project_home.activity.published', '{actor} published a new version', { actor }),
    // Content changes. The rows carry ids and counts only; the title comes
    // from the change log, read with the reader's access, or not at all.
    'content.edited': editedSentence,
    'doc.edited': editedSentence,
    'content.created': (c) => tx(c, 'project_home.activity.content_created', '{actor} created {thing}'),
    'content.renamed': (c) => tx(c, 'project_home.activity.content_renamed', '{actor} renamed {thing}'),
    'content.moved_in': (c) => tx(c, 'project_home.activity.content_moved_in', '{actor} moved {thing} into the project'),
    'content.moved_out': (c) => tx(c, 'project_home.activity.content_moved_out', '{actor} moved {thing} out of the project'),
    'content.restored': (c) => tx(c, 'project_home.activity.content_restored', '{actor} restored an earlier version of {thing}'),
    'doc.restored': (c) => tx(c, 'project_home.activity.content_restored', '{actor} restored an earlier version of {thing}'),
    'content.version_named': (c) => tx(c, 'project_home.activity.content_named', '{actor} named a version of {thing}'),
    'comment.thread.created': commentSentence('project_home.activity.comment_thread_created', '{actor} commented on {thing}'),
    'comment.created': commentSentence('project_home.activity.comment_created', '{actor} replied to a comment on {thing}'),
    'comment.updated': commentSentence('project_home.activity.comment_updated', '{actor} edited a comment on {thing}'),
    'comment.deleted': commentSentence('project_home.activity.comment_deleted', '{actor} deleted a comment on {thing}'),
    'comment.resolved': commentSentence('project_home.activity.comment_resolved', '{actor} resolved a comment thread on {thing}'),
    'comment.reopened': commentSentence('project_home.activity.comment_reopened', '{actor} reopened a comment thread on {thing}'),
    'comment.thread.deleted': commentSentence('project_home.activity.comment_thread_deleted', '{actor} deleted a comment thread on {thing}'),
    'comment.thread.updated': commentSentence('project_home.activity.comment_thread_updated', '{actor} changed how the AI takes part in a comment thread on {thing}'),
    'comment.mention': commentSentence('project_home.activity.comment_mention', '{actor} mentioned someone in a comment on {thing}'),
};

function tx(c: Ctx, key: string, fallback: string): string {
    return c.t(key, fallback, { actor: c.actor, thing: itemOf(c) });
}

/** "+12 words, −3 words" and how many saves an editing session folded, or null. */
export function changeMeta(item: ActivityEntry, t: TFn): string | null {
    if (item.action !== 'content.edited') return null;
    const d = (item.details && typeof item.details === 'object' ? item.details : {}) as Record<string, unknown>;
    const s = (d.stats && typeof d.stats === 'object' ? d.stats : {}) as Record<string, unknown>;
    const n = (v: unknown) => (typeof v === 'number' && v > 0 ? v : 0);
    const parts: string[] = [];
    if (n(s.wordsAdded)) parts.push(t('project_home.activity.words_added', '+{n} words', { n: n(s.wordsAdded) }));
    if (n(s.wordsRemoved)) parts.push(t('project_home.activity.words_removed', '−{n} words', { n: n(s.wordsRemoved) }));
    if (n(d.changes) > 1) parts.push(t('project_home.activity.saves', '{n} saves', { n: n(d.changes) }));
    return parts.length ? parts.join(' · ') : null;
}

export function describeActivity(item: ActivityEntry, names: ActivityNames, t: TFn): string {
    const actor = actorOf(item, names, t);
    const d = (item.details && typeof item.details === 'object' ? item.details : {}) as Record<string, unknown>;
    const sentence = SENTENCES[item.action];
    if (sentence) return sentence({ item, actor, names, t, d });
    return t('project_home.activity.other', '{actor} made a change ({action})', { actor, action: item.action });
}
