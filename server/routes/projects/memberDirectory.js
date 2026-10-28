/**
 * Names and pictures for the people and groups of one project: the labels a
 * member list and the invite picker show, never an e-mail address.
 *
 * Moved here unchanged from routes/projects.js. `makeMemberDirectory(deps)`
 * takes the user store, so routes/projects.js hands it the same store handle
 * its route tests replace, and this module's own test serves it a fake.
 */

'use strict';

const log = require('../../telemetry/log');

/** The display name a member list shows for a user row (the same rule as the documents' people). */
const { displayNameOf } = require('../../core/documents/documentPeople');

const { projectOrgOf, belongsToProjectOrg } = require('../../projects/projectOrg');

/**
 * How a member's own avatar reaches the list: an emoji, a path or a url inline;
 * an uploaded picture (a data URL of up to hundreds of KB) NOT inline, since it
 * would ride along on every member list, but as a link to the avatar route
 * (routes/projects/members.js), versioned by its content so a changed picture
 * is fetched again.
 *
 * @returns {{ avatar: string, avatarType: 'emoji'|'image'|'url' }|null}
 * @param {string} userId
 */
function memberAvatar(projectId, userId, user) {
    const avatar = typeof user.avatar === 'string' ? user.avatar : '';
    if (!avatar || !['emoji', 'image', 'url'].includes(user.avatarType)) return null;
    if (avatar.startsWith('data:image/')) {
        const v = require('crypto').createHash('sha256').update(avatar).digest('hex').slice(0, 10);
        return { avatar: `/api/projects/${projectId}/avatars/${encodeURIComponent(userId)}?v=${v}`, avatarType: 'image' };
    }
    return avatar.length <= 2048 ? { avatar, avatarType: user.avatarType } : null;
}

/**
 * @param {{ userStore: Pick<typeof import('../../stores/userStore'), 'getUser'|'getGroup'> }} deps
 */
function makeMemberDirectory({ userStore }) {
    /**
     * Names for the owner and the member rows of one project.
     *
     * Only principals of the PROJECT'S organisation are described (org-less
     * projects: org-less principals only), from an explicit allow-list of fields:
     * a user is `{ name, avatar?, avatarType? }`, a group `{ name }`. Never an e-mail address: any
     * viewer may read this list, and the organisation's directory
     * (users.getOrgMembersForDirectory) gives a non-admin no addresses either; a
     * picker or a member list needs a label, not an address. A share row pointing across
     * a tenant boundary, which the share route refuses to create but older rows
     * may carry, stays an id without a name. A lookup that fails leaves that
     * principal unnamed rather than failing the member list.
     *
     * @returns {Promise<{ people: Record<string, {name?: string}>, groups: Record<string, {name?: string}> }>}
     */
    async function describeMembers(project, shares) {
        const org = await projectOrgOf(project);
        const userIds = new Set([project.ownerId]);
        const groupIds = new Set();
        for (const share of shares) {
            if (share.sharedWithType === 'user') userIds.add(share.sharedWithId);
            else if (share.sharedWithType === 'group') groupIds.add(share.sharedWithId);
        }

        const people = {};
        await Promise.all([...userIds].filter(Boolean).map(async (id) => {
            let user = null;
            try { user = await userStore.getUser(id); } catch (err) {
                log.warn('[Projects] member lookup failed:', /** @type {Error} */ (err).message);
            }
            if (!user || !await belongsToProjectOrg(id, org).catch(() => false)) return;
            const name = displayNameOf(user);
            const entry = name ? { name } : {};
            const picture = memberAvatar(project.id, id, user);
            if (picture) Object.assign(entry, picture);
            people[id] = entry;
        }));

        // One targeted read per group the project is shared with, never the whole
        // groups table of the install: this list is read on every project page.
        const groups = {};
        await Promise.all([...groupIds].filter(Boolean).map(async (id) => {
            let group = null;
            try { group = await userStore.getGroup(id); } catch (err) {
                log.warn('[Projects] group lookup failed:', /** @type {Error} */ (err).message);
            }
            if (!group || group.id !== id || (group.organizationId || '') !== org) return;
            groups[id] = typeof group.name === 'string' && group.name ? { name: group.name } : {};
        }));
        return { people, groups };
    }

    return { describeMembers };
}

module.exports = { memberAvatar, makeMemberDirectory };
