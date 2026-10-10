// @typecheck
/**
 * The bell for every collaboration event of a project: a mention in a team chat
 * or a comment, being added, a role change, being removed, a member leaving,
 * a change of owner. Who is told is decided here (the actor never, a muted
 * project or a switched-off event never, through notificationPrefsStore); what
 * is said is rendered in the recipient's language from the `project_collab`
 * catalogue.
 *
 * Privacy: a notification (and the mail of the same event) carries the project
 * name, the kind of event, the actor's display name and an in-app link. Never
 * what was written, never an e-mail address. The text variables are built from
 * named fields, never from a row.
 *
 * Best effort throughout: a bell that does not ring never undoes the change
 * that caused it, so nothing here throws.
 */

'use strict';

const log = require('../telemetry/log');

/** A group bigger than this is not fanned out: a mass ring is not a notification. */
const GROUP_CAP = 200;

/**
 * Resolve `<key>.title` / `<key>.message` for a user in their own language.
 * A `role` variable (viewer/editor) is translated first.
 *
 * @param {object} [deps]
 * @param {Function} [deps.getUser]    (id) => user row with preferredLocale
 * @param {Function} [deps.translate]  (locale, key, vars) => Promise<string>
 * @returns {(p: { userId: string, key: string, vars?: Record<string, string>, parts?: string[] }) => Promise<Record<string, string>>}
 *   `parts` names the sub-keys to resolve (default title + message; the mail asks for `detail`)
 */
function makeRenderText(deps = {}) {
    const getUser = deps.getUser || ((id) => require('../stores/userStore').getUser(id));
    const translate = deps.translate || ((locale, key, vars) => require('../i18n/translate').translate(locale, key, vars));
    return async function renderText({ userId, key, vars = {}, parts = ['title', 'message'] }) {
        let locale = 'en';
        try { locale = (await getUser(userId))?.preferredLocale || 'en'; } catch { locale = 'en'; }
        const filled = { ...vars };
        if (typeof filled.role === 'string' && filled.role) {
            filled.role = await translate(locale, `project_home.role.${filled.role}`, {});
        }
        /** @type {Record<string, string>} */
        const out = {};
        for (const part of parts) out[part] = await translate(locale, `${key}.${part}`, filled);
        return out;
    };
}

/**
 * @param {object} [deps]
 * @param {Function} [deps.createNotification]  ({ userId, category, title, message, link }) => notification
 * @param {{ filterRecipients: Function }} [deps.prefs]  (userIds, projectId, event) => { bell, email }
 * @param {Function} [deps.sendEmail]           ({ userId, event, vars: { project, actor, intro, detail }, ctaUrl }) => void; the mail of the same event (default: emailService.sendProjectCollabEmail)
 * @param {Function} [deps.clientHost]          () => the app's absolute origin, for the link in the mail
 * @param {Function} [deps.renderText]          ({ userId, key, vars }) => { title, message } in the recipient's locale
 * @param {Function} [deps.projectPath]         (projectId, section) => in-app path
 * @param {Function} [deps.groupMemberIds]      (groupId, cap) => { ids, total }
 * @param {Function} [deps.getUser]             (id) => user row, for the actor's display name
 */
function makeCollabNotifier(deps = {}) {
    const createNotification = deps.createNotification || ((n) => require('../stores/notificationStore').createNotification(n));
    const prefs = deps.prefs || { filterRecipients: (ids, projectId, event) => require('../stores/notificationPrefsStore').filterRecipients(ids, projectId, event) };
    const sendEmail = deps.sendEmail || ((mail) => require('../utils/emailService').sendProjectCollabEmail(mail));
    const clientHost = deps.clientHost || (() => require('../utils/appPaths').clientHost());
    const getUser = deps.getUser || ((id) => require('../stores/userStore').getUser(id));
    const renderText = deps.renderText || makeRenderText({ getUser });
    const projectPath = deps.projectPath || ((id, section) => require('../utils/appPaths').projectPath(id, section));
    const groupMemberIds = deps.groupMemberIds
        || ((groupId, cap) => require('../core/automationRunner/approvalLifecycle').groupMemberIds(groupId, cap));

    /** The actor as the others see them: a display name, never an e-mail address. */
    async function nameOf(userId) {
        try {
            const user = userId ? await getUser(userId) : null;
            return require('./chatAssistant').displayNameOf(user);
        } catch {
            return require('./chatAssistant').displayNameOf(null);
        }
    }

    const unique = (ids, except) => [...new Set(ids || [])].filter((id) => id && id !== except);

    /**
     * Ring (and mail) the given people for one event. The prefs decide per channel.
     * `name` is the person the text speaks of; `except` is never told.
     * @param {string} event
     * @param {string} key
     * @param {{ id: string, name: string }} project
     * @param {string[]} userIds
     * @param {{ except?: string|null, name: Promise<string>, link: string|null, category?: string, vars?: Record<string, unknown>, emailKey?: string }} opts
     *   `emailKey` is the catalogue key of the mail's one-sentence `detail`
     */
    async function notify(event, key, project, userIds, { except = null, name, link, category = 'heads_up', vars = {}, emailKey = `project_collab.email.${event}` }) {
        try {
            const ids = unique(userIds, except);
            if (!ids.length) return 0;
            const { bell, email } = await prefs.filterRecipients(ids, project.id, event);
            const actor = await name;
            for (const userId of bell) {
                try {
                    const { title, message } = await renderText({ userId, key, vars: { project: project.name, actor, ...vars } });
                    await createNotification({ userId, category, title, message, link });
                } catch (err) {
                    log.warn(`[ProjectCollab] ${event} notification to ${userId} not created: ${err && err.message}`);
                }
            }
            for (const userId of email) {
                try {
                    // Only after the bell loop: a mail that fails never holds the bell back.
                    const { intro, detail } = await renderText({ userId, key: emailKey, vars: { project: project.name, actor, ...vars }, parts: ['intro', 'detail'] });
                    await sendEmail({
                        userId,
                        event,
                        vars: { project: project.name, actor, intro, detail },
                        ctaUrl: link ? `${clientHost()}${link}` : null,
                    });
                } catch (err) {
                    log.warn(`[ProjectCollab] ${event} mail to ${userId} not sent: ${err && err.message}`);
                }
            }
            return bell.length;
        } catch (err) {
            log.warn(`[ProjectCollab] ${event} not notified: ${err && err.message}`);
            return 0;
        }
    }

    /** The people mentioned in a team chat message, except the writer. */
    async function chatMentioned({ project, actorId, mentionedUserIds, chatId }) {
        return notify('chat_mention', 'project_collab.bell.chat_mention', project, mentionedUserIds, {
            except: actorId, name: nameOf(actorId), link: projectPath(project.id, `chats/${chatId}`),
        });
    }

    /** The people mentioned in a comment on a document or notebook (tasks go through taskNotify), except the writer. */
    async function commentMentioned({ project, actorId, mentionedUserIds, targetType, targetId }) {
        return notify('comment_mention', 'project_collab.bell.comment_mention', project, mentionedUserIds, {
            except: actorId, name: nameOf(actorId), link: projectPath(project.id, `${targetType}s/${targetId}`),
        });
    }

    /** A person, or the members of a group, newly given access. */
    async function added({ project, actorId, sharedWithType, sharedWithId, role }) {
        let ids = [];
        if (sharedWithType === 'group') {
            try {
                const members = await groupMemberIds(sharedWithId, GROUP_CAP);
                if (!members || members.total > GROUP_CAP) {
                    log.warn(`[ProjectCollab] group ${sharedWithId} has more than ${GROUP_CAP} members: nobody is notified of the share`);
                    return 0;
                }
                ids = members.ids;
            } catch (err) {
                log.warn(`[ProjectCollab] members of group ${sharedWithId} unknown: ${err && err.message}`);
                return 0;
            }
        } else if (sharedWithType === 'user') {
            ids = [sharedWithId];
        }
        return notify('added', 'project_collab.bell.added', project, ids, {
            except: actorId, name: nameOf(actorId), link: projectPath(project.id), vars: { role },
        });
    }

    async function roleChanged({ project, actorId, userId, to }) {
        return notify('role_changed', 'project_collab.bell.role_changed', project, [userId], {
            except: actorId, name: nameOf(actorId), link: projectPath(project.id), vars: { role: to },
        });
    }

    /** No link: the person can no longer open the project. */
    async function removed({ project, actorId, userId }) {
        return notify('removed', 'project_collab.bell.removed', project, [userId], {
            except: actorId, name: nameOf(actorId), link: null,
        });
    }

    /** A member left: the owner is told. */
    async function left({ project, userId }) {
        return notify('left', 'project_collab.bell.left', project, [project.ownerId], {
            except: userId, name: nameOf(userId), link: projectPath(project.id, 'members'),
        });
    }

    /** The new owner is told, and so is the previous one when somebody else made the change. */
    async function ownerChanged({ project, actorId, fromUserId, toUserId }) {
        const link = projectPath(project.id);
        const toNew = await notify('owner_changed', 'project_collab.bell.owner_changed', project, [toUserId], {
            except: actorId, name: nameOf(fromUserId), link,
        });
        const toOld = await notify('owner_changed', 'project_collab.bell.owner_handed', project, [fromUserId], {
            except: actorId, name: nameOf(toUserId), link, emailKey: 'project_collab.email.owner_handed',
        });
        return toNew + toOld;
    }

    /** The people newly given a task, except the one who gave it: bell and mail, as their prefs say. Never the task's text. */
    async function taskAssigned({ project, actorId, assigneeIds, taskId }) {
        return notify('task_assigned', 'project_collab.bell.task_assigned', project, assigneeIds, {
            except: actorId, name: nameOf(actorId), link: projectPath(project.id, `tasks/${taskId}`),
        });
    }

    return { chatMentioned, commentMentioned, added, roleChanged, removed, left, ownerChanged, taskAssigned };
}

module.exports = { makeCollabNotifier, makeRenderText, GROUP_CAP };
