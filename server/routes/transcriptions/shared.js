/**
 * Transcriptions — shared route helpers.
 *
 * Access-context resolution (org + group IDs for ACL queries), the org lookup
 * for EU-mode tier overrides, the mandatory client-payload funnel
 * (withInsightsPolicy / describeAudio) and small pipeline helpers shared by
 * the transcription sub-routers mounted from routes/transcriptions.js.
 */

const fs = require('fs');
const summaryTemplateStore = require('../../stores/summaryTemplateStore');

/** A user-supplied speaker count → a positive int, or null (Auto). */
function parseSpeakerCount(raw) {
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 50) : null;
}

/**
 * Resolve the user's group IDs from userStore — used to filter published
 * transcriptions by `shared_groups`. Mirrors `resolveUserGroups` in
 * `server/routes/knowledgeBases.js`.
 */
async function resolveUserGroupIds(req) {
    const userId = req.session?.user?.id;
    if (!userId) return [];
    try {
        const userStore = require('../../stores/userStore');
        const user = await userStore.getUser(userId);
        if (!user) return [];
        if (Array.isArray(user.groups)) return user.groups;
        if (typeof user.groups === 'string') {
            try { return JSON.parse(user.groups || '[]'); } catch { return []; }
        }
    } catch (_) { /* ignore */ }
    return [];
}

/**
 * Resolve the user's full read-access context for transcription queries:
 * org IDs they belong to (for org-scoped published rows) and group IDs
 * (for `shared_groups` filtering).
 */
async function resolveAccessContext(req) {
    const { resolveUserOrgIds } = require('../../auth');
    const orgIdsSet = await resolveUserOrgIds(req);
    // Super admin → orgIdsSet is null. Pass through a sentinel that allows all
    // by combining the user's actual orgs (best effort) with an org-agnostic
    // path inside the store. For simplicity, super admins still see their own
    // + their primary org's published items; cross-org snooping isn't a
    // supported flow in the UI.
    const orgIds = orgIdsSet === null
        ? []
        : Array.from(orgIdsSet || []);
    const userGroupIds = await resolveUserGroupIds(req);
    return { orgIds, userGroupIds, isSuperAdmin: orgIdsSet === null };
}

/**
 * Resolve the user's organization ID from a request for EU-mode tier overrides.
 */
async function resolveUserOrgFromReq(req) {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return null;
        const { resolveUserOrgIds } = require('../../auth');
        const orgIds = await resolveUserOrgIds(req);
        if (orgIds && orgIds.size > 0) return Array.from(orgIds)[0];
        const userStore = require('../../stores/userStore');
        const dbUser = await userStore.getUser(userId);
        if (dbUser?.organizationId) return dbUser.organizationId;
        const groups = Array.isArray(dbUser?.groups) ? dbUser.groups : (() => { try { return JSON.parse(dbUser?.groups || '[]'); } catch (_) { return []; } })();
        if (groups.length > 0) {
            const allGroups = await userStore.getAllGroups();
            for (const gid of groups) {
                const g = allGroups.find(gr => gr.id === gid);
                if (g?.organizationId) return g.organizationId;
            }
        }
    } catch (_) {}
    return null;
}

// Voxtral sends the whole file in one SDK call; the old 5-minute timeout was
// routinely too tight for hour-plus recordings.
const VOXTRAL_TIMEOUT_MS = Number(process.env.VOXTRAL_TIMEOUT_MS) || 1_800_000;

/**
 * Resolve the caller's default summary TEMPLATE (personal ▸ group ▸ org) so a
 * saved default also styles the FIRST auto-generated summary of a new meeting,
 * not just Regenerate. Best-effort — returns null (→ the built-in
 * first-generation prompt) on any failure.
 *
 * De hele RIJ, niet alleen `prompt`: de notitie wordt met het id én de versie
 * van dit sjabloon gestempeld (M4 stap 3), en uit een promptstring is geen id
 * terug te winnen. Terugvallen op "zoek het sjabloon met dezelfde tekst" zou
 * het verkeerde sjabloon noemen zodra er twee met dezelfde alinea bestaan.
 *
 * Faalt de lookup, dan is het antwoord null — en null stempelt NIETS. De
 * samenvatting is dan met de ingebouwde eerste-generatieprompt geschreven, en
 * die is geen van de vijf ingebouwde sjablonen: er is dus niets waars te
 * melden, en het scherm zwijgt.
 */
async function resolveDefaultTemplateForReq(req, userId, userOrgId) {
    try {
        const groupIds = await resolveUserGroupIds(req);
        return await summaryTemplateStore.resolveDefaultTemplate({
            userId,
            orgIds: userOrgId ? [userOrgId] : [],
            groupIds,
        });
    } catch (_) {
        return null;
    }
}

/**
 * Turn a stored note into the payload the CLIENT is allowed to see, and attach
 * the org's Insights display policy.
 *
 * Every route that returns a whole note must go through this: the speaker
 * editor and re-identify both replace the client's note object wholesale, so a
 * response without the flag silently re-enables per-person stats for an org
 * that switched them off.
 *
 * The Insights flag is a DISPLAY policy, not an access boundary — the numbers
 * are derived from `segments`, which the payload has to carry for the
 * transcript and timeline anyway. It exists so an org can stop the product from
 * PRESENTING colleagues as ranked figures (the works-council concern), not to
 * hide data the viewer already holds. Best-effort: unavailable config means
 * allowed.
 *
 * The field STRIPPING below is an access boundary, and it is why this function
 * is the mandatory funnel rather than a convenience:
 *
 *   - `audioPath` / `audioStorageKey` are server-side locations. Handing the
 *     path to every reader made the raw recording fetchable outside the ACL
 *     entirely (see the /uploads allowlist in index.js). Nothing in the client
 *     uses them — playback goes through GET /:id/audio, which re-checks access.
 *   - `voiceprintMatches` is biometric diagnostics: colleagues' names, internal
 *     user ids and raw acoustic confidence, including near-misses for people
 *     who were probably not even in the meeting. `routes/voiceprints.js`
 *     withholds the enrolled-user list from non-admins; shipping it inside
 *     every shared note contradicted that. Owner only.
 */
async function withInsightsPolicy(transcription) {
    let perPersonInsights = true;
    if (transcription?.organizationId) {
        try {
            const talkNotes = require('../../core/meetingNotes/talkNotesSettings');
            const orgSettings = await talkNotes.getOrgSettings(transcription.organizationId);
            perPersonInsights = orgSettings.insightsPerPersonStats !== false;
        } catch (_) { /* config unavailable → default */ }
    }
    const { audioPath, audioStorageKey, voiceprintMatches, ...safe } = transcription || {};
    return {
        ...safe,
        ...(transcription?.isOwner ? { voiceprintMatches: voiceprintMatches || [] } : {}),
        // Derived, never the raw locations. The client needs to know whether the
        // recording is playable, whether it is safely backed up, and — when it
        // is not — whether that is a passing outage or permanent, so it can say
        // something true instead of "please upload again".
        audio: await describeAudio(transcription),
        perPersonInsights,
    };
}

/**
 * Playability summary for one note. Deliberately leaks no paths or keys.
 */
async function describeAudio(transcription) {
    if (!transcription) return { available: false, durable: false, localOnly: false, storageConfigured: false, recoverable: false, capture: null };
    const durable = !!transcription.audioStorageKey;
    let localPresent = false;
    if (transcription.audioPath) {
        // One stat. Wrapped so a slow or unhappy filesystem can never take the
        // whole note payload down with it; optimistic on error because the audio
        // route is the real authority.
        try { await fs.promises.access(transcription.audioPath); localPresent = true; } catch (_) { localPresent = false; }
    }
    let storageConfigured = false;
    try { storageConfigured = !!require('../../stores/storageStore').getStatus().configured; } catch (_) { /* default */ }
    return {
        available: localPresent || durable,
        durable,
        // Playable right now, but one pod restart from gone — the state the
        // backfill exists to clear.
        localOnly: localPresent && !durable,
        storageConfigured,
        // Not here, but a durable copy exists → this is an outage, not loss.
        recoverable: !localPresent && durable,
        capture: transcription.source || null,
    };
}

module.exports = {
    parseSpeakerCount,
    resolveUserGroupIds,
    resolveAccessContext,
    resolveUserOrgFromReq,
    VOXTRAL_TIMEOUT_MS,
    resolveDefaultTemplateForReq,
    withInsightsPolicy,
    describeAudio,
};
