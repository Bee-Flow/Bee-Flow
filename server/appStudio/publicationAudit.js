/**
 * publicationAudit.js — the record of an app's AUDIENCE changing.
 *
 * Building an app is a private act; publishing one is not. The events here are
 * the ones that change who can reach something, and they are the ones an
 * incident review asks about after the fact:
 *
 *   • published to the whole organisation, or to named groups
 *   • unpublished
 *   • a public page minted — an internet-reachable URL that needs no account,
 *     no session and no organisation membership. This is the largest exposure
 *     change the studio can make and it took one POST with no record of who,
 *     when, or which app.
 *   • that URL revoked
 *   • surfaced in the Nextcloud menu for everyone in the org
 *
 * Nothing here records app CONTENT. The row names the app, its owner, who acted
 * and the audience — not the definition, not the data, not the page body. An
 * audit trail that copies what it audits becomes a second place the data lives.
 *
 * Best-effort in the same sense as auth/loginAudit.js: a publish must not fail
 * because the audit table is unavailable. A missing row is a gap in a log; a
 * throw here would refuse a publish for a reason nobody could act on.
 */
const log = require('../telemetry/log');

const PUBLICATION_ACTIONS = Object.freeze({
    PUBLISHED: 'studio_app_published',
    UNPUBLISHED: 'studio_app_unpublished',
    PUBLIC_PAGE_CREATED: 'studio_app_public_page_created',
    PUBLIC_PAGE_REVOKED: 'studio_app_public_page_revoked',
    NEXTCLOUD_MENU_CHANGED: 'studio_app_nextcloud_menu_changed',
});

/**
 * How wide an audience a publish gives, as a word rather than a list of ids.
 * 'organisation' and 'groups' are the two answers that matter when someone asks
 * "who could see this"; the group ids are recorded alongside so the answer can
 * be made exact, but the word is what a reader scans for.
 */
function audienceOf(isPublished, sharedGroups) {
    if (!isPublished) return 'nobody';
    const groups = Array.isArray(sharedGroups) ? sharedGroups.filter(Boolean) : [];
    return groups.length > 0 ? 'groups' : 'organisation';
}

async function record(action, { app, actorId, organizationId, details }) {
    try {
        const userStore = require('../stores/userStore');
        await userStore.logAccessAudit(
            action,
            'studio_app',
            app?.id || 'unknown',
            actorId || 'system',
            null,
            {
                appName: app?.name || null,
                ownerId: app?.userId || null,
                ...details,
            },
            organizationId || app?.organizationId || null,
        );
    } catch (e) {
        log.error('[StudioApps] could not record', action, '-', e.message);
    }
}

/** Publish state changed. `isPublished` decides which of the two actions it is. */
async function auditPublishChange({ app, actorId, isPublished, sharedGroups, organizationId, publishedVersion }) {
    await record(isPublished ? PUBLICATION_ACTIONS.PUBLISHED : PUBLICATION_ACTIONS.UNPUBLISHED, {
        app, actorId, organizationId,
        details: {
            audience: audienceOf(isPublished, sharedGroups),
            sharedGroups: Array.isArray(sharedGroups) ? sharedGroups : [],
            publishedVersion: publishedVersion ?? null,
        },
    });
}

/**
 * A public URL was minted or revoked.
 *
 * The token is NOT recorded. It is the credential — anyone holding it can open
 * the page — so writing it into a table that org admins read and support
 * exports would hand out the very thing revoking is supposed to take back. The
 * row carries a short prefix, which is enough to line an audit row up against a
 * URL somebody shows you and useless on its own.
 */
async function auditPublicPage({ app, actorId, token, created }) {
    await record(created ? PUBLICATION_ACTIONS.PUBLIC_PAGE_CREATED : PUBLICATION_ACTIONS.PUBLIC_PAGE_REVOKED, {
        app, actorId,
        details: {
            tokenPrefix: typeof token === 'string' && token ? `${token.slice(0, 6)}…` : null,
            reachableWithoutAccount: true,
        },
    });
}

/** The app was added to, or removed from, the organisation's Nextcloud menu. */
async function auditNextcloudMenu({ app, actorId, enabled }) {
    await record(PUBLICATION_ACTIONS.NEXTCLOUD_MENU_CHANGED, {
        app, actorId, details: { enabled: !!enabled },
    });
}

module.exports = {
    PUBLICATION_ACTIONS,
    audienceOf,
    auditPublishChange,
    auditPublicPage,
    auditNextcloudMenu,
};
