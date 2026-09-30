/**
 * One line of a project's activity trail, in words — the port of
 * formatActivity in the web's components/projects/ProjectDetailPage.jsx.
 *
 * Names come from the directory when the caller may read it (see people.ts);
 * otherwise the line says "Someone" and a short id, exactly as the web does
 * for a member without admin rights. An action this table does not know is
 * named as the server wrote it, humanised, rather than dropped: a feed that
 * silently skips a row is a feed that lies about what happened.
 */

import type { TranslateFn } from '@/core/i18n';

import type { NameFor } from './people';
import type { ActivityItem } from './types';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** `blueprint.published` → "Blueprint published". */
export function humaniseAction(action: string): string {
    const words = action.replace(/[._]/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
}

/** Who the row is about: a person or group by name, else a short id. */
function subjectOf(item: ActivityItem, nameFor: NameFor): string {
    const id = item.targetId ?? '';
    if (item.targetType === 'user' || item.targetType === 'group') {
        return nameFor({ sharedWithId: id, sharedWithType: item.targetType }) ?? id.slice(0, 8);
    }
    return id.slice(0, 8);
}

function roleWord(role: string, t: TranslateFn): string {
    if (role === 'editor') return t('solutions.install_role_editor', 'Can edit');
    return t('solutions.install_role_viewer', 'Can view');
}

type Line = (item: ActivityItem, who: string, subject: string, t: TranslateFn) => string;

const LINES: Readonly<Record<string, Line>> = {
    project_created: (_i, who, _s, t) => t('mobile.projects.activity_created', '{who} created the project', { who }),
    project_updated: (i, who, _s, t) => {
        const changes = i.details.changes;
        const fields = changes && typeof changes === 'object' ? Object.keys(changes).join(', ') : '';
        return fields
            ? t('mobile.projects.activity_updated_fields', '{who} updated {fields}', { who, fields })
            : t('mobile.projects.activity_updated', '{who} updated the project', { who });
    },
    instructions_updated: (_i, who, _s, t) =>
        t('mobile.projects.activity_instructions', '{who} updated the project instructions', { who }),
    member_added: (i, who, subject, t) =>
        t('mobile.projects.activity_member_added', '{who} added {subject} ({role})', {
            who,
            subject,
            role: roleWord(text(i.details.role), t),
        }),
    member_removed: (i, who, subject, t) =>
        i.details.selfLeave === true
            ? t('mobile.projects.activity_left', '{who} left the project', { who })
            : t('mobile.projects.activity_member_removed', '{who} removed {subject}', { who, subject }),
    member_role_changed: (i, who, subject, t) =>
        t('mobile.projects.activity_role_changed', "{who} changed {subject}'s role from {from} to {to}", {
            who,
            subject,
            from: text(i.details.from) || '?',
            to: text(i.details.to) || '?',
        }),
    kb_added: (_i, who, _s, t) => t('mobile.projects.activity_kb_added', '{who} attached a knowledge base', { who }),
    kb_removed: (_i, who, _s, t) => t('mobile.projects.activity_kb_removed', '{who} removed a knowledge base', { who }),
    conversation_assigned: (_i, who, _s, t) =>
        t('mobile.projects.activity_conversation_added', '{who} added a conversation', { who }),
    conversation_unassigned: (_i, who, _s, t) =>
        t('mobile.projects.activity_conversation_removed', '{who} removed a conversation', { who }),
    resource_added: (i, who, _s, t) =>
        t('mobile.projects.activity_resource_added', '{who} filed something in ({kind})', {
            who,
            kind: humaniseAction(text(i.targetType)).toLowerCase() || '?',
        }),
    resource_removed: (i, who, _s, t) =>
        t('mobile.projects.activity_resource_removed', '{who} took something out ({kind})', {
            who,
            kind: humaniseAction(text(i.targetType)).toLowerCase() || '?',
        }),
    'blueprint.published': (_i, who, _s, t) =>
        t('mobile.projects.activity_published', '{who} published a new version', { who }),
};

/** The sentence for one activity row. */
export function activityLine(item: ActivityItem, nameFor: NameFor, t: TranslateFn): string {
    const actor = item.actorId ? nameFor({ sharedWithId: item.actorId, sharedWithType: 'user' }) : null;
    const who = actor ?? t('mobile.projects.activity_someone', 'Someone');
    const line = LINES[item.action];
    if (line) return line(item, who, subjectOf(item, nameFor), t);
    return t('mobile.projects.activity_other', '{who}: {action}', { who, action: humaniseAction(item.action) });
}
