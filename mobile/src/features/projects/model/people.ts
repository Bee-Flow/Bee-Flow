/**
 * Who is on a project, in words. Member rows carry only ids; the directory
 * turns them into names when the caller may read it, and these fall back to
 * roles when not.
 */

import type { TranslateFn } from '@/core/i18n';

import type { Directory, ProjectRole, ProjectShare } from './types';

export type ShareRef = Pick<ProjectShare, 'sharedWithId' | 'sharedWithType'>;
export type NameFor = (share: ShareRef) => string | null;

export function nameResolver(directory: Directory | undefined): NameFor {
    const users = new Map(
        (directory?.users ?? []).map((user) => [
            user.id,
            user.displayName || user.username || user.email || user.id,
        ]),
    );
    const groups = new Map((directory?.groups ?? []).map((group) => [group.id, group.name ?? group.id]));
    return (share) => (share.sharedWithType === 'group' ? groups : users).get(share.sharedWithId) ?? null;
}

/** A member row's title: "You", their name, or what kind of member they are. */
export function memberTitle(share: ProjectShare, meId: string | undefined, nameFor: NameFor, t: TranslateFn): string {
    if (share.sharedWithType === 'user' && share.sharedWithId === meId) return t('mobile.projects.you', 'You');
    const name = nameFor(share);
    if (name) return name;
    return share.sharedWithType === 'group'
        ? t('forms.share.audience_group_short', 'A group')
        : t('mobile.projects.a_colleague', 'A colleague');
}

/** The role in words, the web's own labels. */
export function roleLabel(role: ProjectRole, t: TranslateFn): string {
    if (role === 'owner') return t('solutions.card_role_owner', 'owner');
    if (role === 'editor') return t('solutions.card_role_editor', 'editor');
    return t('solutions.card_role_viewer', 'viewer');
}

/** The caller's own share on this project, when they are on it as a PERSON (they can leave). */
export function ownShare(members: readonly ProjectShare[], meId: string | undefined): ProjectShare | null {
    if (!meId) return null;
    return members.find((m) => m.sharedWithType === 'user' && m.sharedWithId === meId) ?? null;
}
