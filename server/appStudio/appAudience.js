// @typecheck
/**
 * appAudience.js — who an app reaches: publish, unpublish and the groups,
 * with the publication audit and the Nextcloud menu nudge. Extracted from the
 * publish route (PATCH /api/studio-apps/:id/publish) so the stage operator's
 * on/off (design 4.3) goes through the same code, and the same gates, as the
 * owner's publish dialog.
 *
 * Two kinds of app, two writers:
 *   - an ordinary app: a publish FREEZES the working definition, which the
 *     caller has validated (`validateDraft`), through setStudioAppPublished;
 *   - an app of a Solution stage (managed): the published copy is the
 *     deployed release and belongs to the deploy, so only the audience moves,
 *     through setStudioAppAudience. Publishing one that was never deployed is
 *     refused: there is nothing to serve.
 *
 * Answers a verdict instead of writing a response, so the route keeps its
 * own HTTP and this module needs no request:
 *   { ok: true, isPublished, sharedGroups, publishedVersion, managed }
 *   { ok: false, status, body }
 *
 * Collaborators are injected (`deps`); the route passes its own modules.
 */

'use strict';

/**
 * The owner's organisation: their own, else the first organisation one of
 * their groups belongs to. Null when they have neither.
 *
 * @param {string} userId
 * @param {{ getUser: Function, getAllGroups: Function }} userStore
 * @returns {Promise<string|null>}
 */
async function resolveOwnerOrgId(userId, userStore) {
    const owner = await userStore.getUser(userId);
    let organizationId = owner?.organizationId || null;
    if (!organizationId) {
        const groups = Array.isArray(owner?.groups) ? owner.groups
            : (() => { try { return JSON.parse(owner?.groups || '[]'); } catch { return []; } })();
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            const g = allGroups.find(x => groups.includes(x.id) && x.organizationId);
            organizationId = g?.organizationId || null;
        }
    }
    return organizationId;
}

const refuse = (status, body) => ({ ok: false, status, body });

/**
 * The organisation a FIRST publish stamps. Group-scoped publishes derive it
 * from THOSE groups (the owner can be in several organisations); a publish to
 * the whole organisation falls back to the owner's.
 *
 * @returns {Promise<{ organizationId: string }|{ refusal: ReturnType<typeof refuse> }>}
 */
async function firstPublishOrg(app, sharedGroups, userStore) {
    const incomingGroups = Array.isArray(sharedGroups) ? sharedGroups.map(g => String(g)).filter(Boolean) : [];
    if (incomingGroups.length === 0) {
        const organizationId = await resolveOwnerOrgId(app.userId, userStore);
        if (!organizationId) return { refusal: refuse(400, { error: 'Cannot publish: owner has no organisation' }) };
        return { organizationId };
    }
    const allGroups = await userStore.getAllGroups();
    const byId = new Map(allGroups.map(g => [g.id, g]));
    const orgs = new Set();
    for (const gid of incomingGroups) {
        const g = byId.get(gid);
        if (!g) return { refusal: refuse(400, { error: `Unknown group: ${gid}` }) };
        if (g.organizationId) orgs.add(g.organizationId);
    }
    if (orgs.size === 0) return { refusal: refuse(400, { error: 'Cannot publish: shared groups have no organisation' }) };
    if (orgs.size > 1) return { refusal: refuse(400, { error: 'Cannot publish to groups across multiple organisations' }) };
    return { organizationId: [...orgs][0] };
}

/**
 * @typedef {object} AudienceDeps
 * @property {{ setStudioAppPublished: Function, setStudioAppAudience: Function, managedInfoOfApp?: Function }} store
 * @property {{ getUser: Function, getAllGroups: Function }} userStore
 * @property {(orgId: string|null, groups: any) => Promise<string[]|undefined>} validateSharedGroupsForOrg
 * @property {{ auditPublishChange: Function }} audit
 * @property {(orgId: string, meta: object) => void} [notifyMenuChange]
 */

/**
 * Publish, unpublish or re-scope an app.
 *
 * `app` is the row from studioAppStore.getStudioApp. `sharedGroups` undefined
 * keeps the stored groups. `organizationId` is the organisation to stamp; on
 * a first publish it is derived when omitted. `validateDraft` canonicalises
 * and validates an ordinary app's working definition for a publish; it is
 * never called for an app of a Solution stage.
 *
 * @param {{
 *   app: any,
 *   publishing: boolean,
 *   sharedGroups?: string[]|null,
 *   organizationId?: string|null,
 *   actorId: string,
 *   validateDraft?: () => Promise<{ ok: boolean, def?: any, errors?: any[], warnings?: any[] }>,
 *   deps: AudienceDeps,
 * }} args
 */
async function setAppAudience({ app, publishing, sharedGroups, organizationId, actorId, validateDraft, deps }) {
    const { store, userStore, validateSharedGroupsForOrg, audit } = deps;
    // A store without the lookup (a handler test's double) has no stages;
    // the real store's publish writer refuses a managed app on its own anyway.
    const managed = typeof store.managedInfoOfApp === 'function' ? await store.managedInfoOfApp(app) : null;

    let validatedDef;
    if (publishing && !managed && typeof validateDraft === 'function') {
        const verdict = await validateDraft();
        if (!verdict.ok) {
            return refuse(422, { error: 'Fix the app\'s validation errors before publishing', errors: verdict.errors, warnings: verdict.warnings });
        }
        validatedDef = verdict.def;
    }
    if (publishing && managed && !app.publishedDefinition) {
        return refuse(409, {
            error: 'This app has no deployed release yet. Deploy a release to this stage first.',
            code: 'app.not_deployed',
        });
    }

    let stampOrg = organizationId;
    if (stampOrg === undefined && publishing && !app.organizationId) {
        const first = await firstPublishOrg(app, sharedGroups, userStore);
        if ('refusal' in first) return first.refusal;
        stampOrg = first.organizationId;
    }

    // The groups are checked against the app's organisation (an existing one
    // sticks; a new one applies on a first publish). undefined keeps the stored list.
    const effectiveOrg = app.organizationId || stampOrg || null;
    let cleanedGroups;
    try {
        cleanedGroups = await validateSharedGroupsForOrg(effectiveOrg, sharedGroups);
    } catch (e) {
        if (Number(e?.status) >= 400 && Number(e?.status) < 500) return refuse(e.status, { error: e.message });
        throw e;
    }

    let ok;
    let publishedVersion;
    if (managed) {
        ok = await store.setStudioAppAudience(app.id, app.userId, {
            isPublished: publishing, sharedGroups: cleanedGroups, organizationId: stampOrg,
        });
        publishedVersion = app.publishedVersion ?? null;
    } else {
        // app.definitionVersion is the version validatedDef was read at: it
        // travels with the def, so published_version names the draft that
        // actually went live.
        ok = await store.setStudioAppPublished(
            app.id, publishing, app.userId, cleanedGroups, stampOrg, validatedDef,
            publishing ? app.definitionVersion : undefined,
        );
        publishedVersion = publishing ? app.definitionVersion : (app.publishedVersion ?? null);
    }
    if (!ok) return refuse(500, { error: 'Failed to update published status' });

    // After the store write, so the trail never claims a publish that did not
    // take. Best-effort: it cannot fail the publish.
    await audit.auditPublishChange({
        app, actorId, isPublished: publishing, sharedGroups: cleanedGroups,
        organizationId: effectiveOrg, publishedVersion,
    });
    // The connector lists only PUBLISHED apps with the menu flag, so a publish
    // or unpublish of a flagged app adds or removes its icon. Fire-and-forget.
    if (app.nextcloudMenu && effectiveOrg && typeof deps.notifyMenuChange === 'function') {
        deps.notifyMenuChange(effectiveOrg, { reason: publishing ? 'publish' : 'unpublish', appId: app.id });
    }
    return { ok: true, isPublished: publishing, sharedGroups: cleanedGroups, publishedVersion, managed: !!managed };
}

module.exports = { setAppAudience, resolveOwnerOrgId };
