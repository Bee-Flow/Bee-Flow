// @typecheck
// The CMS AI builder's per-site chat snapshot.

const configStore = require('../configStore');
const { isPlainObject, assertSiteId, projectKey } = require('./shared');

// ── AI builder session (per site, shared between admins) ────────────
//
// The CMS AI builder (routes/ai/cmsBuilder.js) persists a small snapshot
// { sessionId, siteId, messages, lastValidation, updatedAt, lastTier } under
//   cms_project_{siteId}_builder_session
// so a refresh/SSE drop rehydrates the chat. The key rides the normal
// cms_project_{siteId}_% cascade in deleteProject, so deleting a site also
// deletes its builder session. Snapshots are trimmed to ≤64KB by dropping
// the OLDEST messages first (same discipline as
// stores/automationStore/builderSessions.js) — the most recent turns are the
// ones a resume needs.

const BUILDER_SESSION_SUFFIX = '_builder_session';
const BUILDER_SNAPSHOT_MAX_BYTES = 64 * 1024;

function builderSessionKey(siteId) {
    return `${projectKey(siteId)}${BUILDER_SESSION_SUFFIX}`;
}

function trimBuilderSnapshot(snapshot) {
    if (!isPlainObject(snapshot)) return null;
    let payload = JSON.stringify(snapshot);
    if (payload.length <= BUILDER_SNAPSHOT_MAX_BYTES) return snapshot;
    const trimmed = { ...snapshot, messages: Array.isArray(snapshot.messages) ? [...snapshot.messages] : [] };
    // Drop oldest messages until we fit; always keep the last two so a
    // resume shows the latest user/assistant exchange.
    while (trimmed.messages.length > 2) {
        trimmed.messages.shift();
        payload = JSON.stringify(trimmed);
        if (payload.length <= BUILDER_SNAPSHOT_MAX_BYTES) break;
    }
    return trimmed;
}

async function getBuilderSession(siteId) {
    assertSiteId(siteId);
    const v = await configStore.getConfigFresh(builderSessionKey(siteId));
    return isPlainObject(v) ? v : null;
}

async function setBuilderSession(siteId, snapshot) {
    assertSiteId(siteId);
    const trimmed = trimBuilderSnapshot(snapshot);
    if (!trimmed) throw new Error('Snapshot must be an object');
    await configStore.setConfig(builderSessionKey(siteId), trimmed);
    return trimmed;
}

module.exports = { getBuilderSession, setBuilderSession };
