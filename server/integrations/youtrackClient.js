// @typecheck strict
/**
 * YouTrack service client — the plain-function surface that server code calls.
 *
 * `youtrackTools.js` is the LLM tool surface: it validates model-supplied
 * arguments and returns prose the model can read. Product features need the
 * same transport without any of that, so the transport, the duplicate
 * prevention and the credential resolution live HERE and the tool file wraps
 * them. One hardened choke point, two callers.
 *
 * CREDENTIALS. The tool file reads a per-user token (`youtrack_*_user_<id>`),
 * which is right for "the AI acts as me" and wrong for a shared support hub:
 * agent A links an issue, agent B opens the ticket an hour later and sees
 * nothing because B never pasted a token. So resolution is service-first —
 * one connection an admin configures once — and falls back to the caller's own
 * token so nothing that works today stops working.
 *
 * This client sends only what it is given. The rule about what may be given
 * is enforced in `support/issueEgress.js`, not here.
 */

const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');
const { SERVICE_URL_KEY, SERVICE_TOKEN_KEY, SERVICE_PROJECT_KEY, ISSUE_ID_RE, FIELDS_ISSUE_SHORT, FIELDS_ISSUE_FULL, youtrackRequest, resolveCredentials, getDefaultProject, sleep, normalizeSummary, resolveProjectShortName } = require('./youtrackClientResolveCredentials');

// ── Transport ─────────────────────────────────────────────────────────────

// ── Credentials ───────────────────────────────────────────────────────────

/**
 * Is a service connection configured, and does it work?
 * Returns { configured, ok, host, projects?, error? } — never the token, and
 * never the full URL beyond its host, because this feeds an admin screen.
 * @param {{ userId?: string | null }} [opts]
 */
async function ping({ userId = null } = {}) {
    const creds = await resolveCredentials({ userId });
    if (!creds) return { configured: false, ok: false, host: /** @type {string | null} */ (null) };

    /** @type {string | null} */
    let host = null;
    try { host = new URL(creds.baseUrl).host; } catch (err) { fallback('integrations/youtrackClient:ping', err); /* malformed URL: reported as not-ok below */ }

    try {
        const projects = await listProjects(creds, { limit: 100 });
        return {
            configured: true,
            ok: true,
            host,
            source: creds.source,
            defaultProject: await getDefaultProject(),
            projects,
        };
    } catch (err) {
        return { configured: true, ok: false, host, source: creds.source, error: /** @type {Error} */ (err).message };
    }
}

// ── Duplicate prevention ──────────────────────────────────────────────────
// YouTrack's REST API has no idempotency mechanism: a POST /issues that times
// out (or dies in a proxy) may still have created the issue server-side. What
// follows is client-side dedup — an exact normalized-summary check before a
// create, and a search-based verification after an ambiguous error.

let VERIFY_DELAY_MS = 2000;
/** @param {number} ms */
function __setVerifyDelayMs(ms) { VERIFY_DELAY_MS = ms; }
function __verifyDelayMs() { return VERIFY_DELAY_MS; }

/**
 * @typedef {{ baseUrl: string, token: string, source?: string }} YoutrackCreds
 */
/**
 * Raw issue JSON as the YouTrack REST API returns it.
 * @typedef {{
 *   id?: string, idReadable?: string, summary?: string, description?: string,
 *   created?: number, updated?: number, resolved?: number | null, commentsCount?: number,
 *   reporter?: { login?: string, fullName?: string },
 *   customFields?: { name: string, value?: { name?: string } }[]
 * }} YtIssue
 */

/**
 * YouTrack full-text search is tokenized and morphological, never exact — the
 * query only narrows candidates and the real match is the normalized compare
 * below. Fails open: a broken search must never block a create.
 * @param {YoutrackCreds} creds
 * @param {string | null} shortName
 * @param {string} summary
 * @param {{ createdAfterMs?: number | null }} [opts]
 */
async function findRecentIssueBySummary({ baseUrl, token }, shortName, summary, { createdAfterMs = null } = {}) {
    if (!shortName || !summary) return null;
    try {
        const params = new URLSearchParams({
            query: `project: {${shortName}} created: {minus 7d} .. Today sort by: created desc`,
            fields: 'idReadable,summary,created',
            $top: '50',
        });
        const issues = await youtrackRequest(baseUrl, token, 'GET', `/issues?${params}`);
        if (!Array.isArray(issues)) return null;
        const wanted = normalizeSummary(summary);
        return issues.find(i =>
            normalizeSummary(i.summary) === wanted
            && (createdAfterMs === null || (typeof i.created === 'number' && i.created >= createdAfterMs))
        ) || null;
    } catch (err) {
        log.warn(`[YouTrack] Duplicate-check search failed (fail-open): ${/** @type {Error} */ (err).message}`);
        return null;
    }
}

// ── Shaping ───────────────────────────────────────────────────────────────

/**
 * Flatten YouTrack's customFields array into the three fields anyone wants.
 * @param {YtIssue} i raw YouTrack issue JSON
 */
function shapeIssue(i) {
    if (!i) return null;
    const cf = (/** @type {string} */ name) => i.customFields?.find((/** @type {{ name: string, value?: { name?: string } }} */ f) => f.name === name)?.value?.name || null;
    return {
        id: i.idReadable || i.id,
        summary: i.summary || '',
        state: cf('State'),
        assignee: cf('Assignee'),
        priority: cf('Priority'),
        type: cf('Type'),
        resolved: !!i.resolved,
        created: i.created ? new Date(i.created).toISOString() : null,
        updated: i.updated ? new Date(i.updated).toISOString() : null,
        commentsCount: Number.isInteger(i.commentsCount) ? i.commentsCount : null,
    };
}

// ── Reads ─────────────────────────────────────────────────────────────────

/**
 * @param {YoutrackCreds} creds
 * @param {string} query
 */
async function searchIssues(creds, query, { limit = 20, skip = 0 } = {}) {
    const params = new URLSearchParams({
        query: query || '',
        fields: FIELDS_ISSUE_SHORT,
        $top: String(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)),
        $skip: String(Math.max(parseInt(skip, 10) || 0, 0)),
    });
    const issues = await youtrackRequest(creds.baseUrl, creds.token, 'GET', `/issues?${params}`);
    return Array.isArray(issues) ? issues.map(shapeIssue) : [];
}

/**
 * @param {YoutrackCreds} creds
 * @param {string} issueId
 */
async function getIssue(creds, issueId) {
    if (!ISSUE_ID_RE.test(issueId || '')) throw new Error('invalid issue id');
    const params = new URLSearchParams({ fields: FIELDS_ISSUE_FULL });
    const issue = await youtrackRequest(creds.baseUrl, creds.token, 'GET', `/issues/${issueId}?${params}`);
    if (!issue) return null;
    return { ...shapeIssue(issue), description: issue.description || '' };
}

/**
 * Issues by id, in as few round trips as possible. The support poller holds a
 * few dozen linked issues and must not spend a request on each — YouTrack's
 * `issue id: A, B, C` accepts a disjunction, so one query answers the batch.
 * @param {YoutrackCreds} creds
 * @param {string[]} [issueIds]
 */
async function getIssuesByIds(creds, issueIds = [], { chunkSize = 50 } = {}) {
    const ids = [...new Set(issueIds.filter(id => ISSUE_ID_RE.test(id || '')))];
    const out = [];
    for (let i = 0; i < ids.length; i += chunkSize) {
        const chunk = ids.slice(i, i + chunkSize);
        const issues = await searchIssues(creds, `issue id: ${chunk.join(', ')}`, { limit: chunk.length });
        out.push(...issues);
    }
    return out;
}

/**
 * Comments on one issue, OLDEST FIRST — that is YouTrack's order and the
 * endpoint takes no sort. `$top` alone therefore reads the start of the thread;
 * a caller after the newest comment skips to the end using the issue's
 * `commentsCount` (see supportIssueSync.latestComment).
 * @param {YoutrackCreds} creds
 * @param {string} issueId
 */
async function getIssueComments(creds, issueId, { limit = 20, skip = 0 } = {}) {
    if (!ISSUE_ID_RE.test(issueId || '')) throw new Error('invalid issue id');
    const params = new URLSearchParams({
        fields: 'id,text,created,author(login,fullName)',
        $top: String(Math.min(Math.max(parseInt(limit, 10) || 20, 1), 50)),
        $skip: String(Math.max(parseInt(skip, 10) || 0, 0)),
    });
    const comments = await youtrackRequest(creds.baseUrl, creds.token, 'GET', `/issues/${issueId}/comments?${params}`);
    if (!Array.isArray(comments)) return [];
    return comments.map(c => ({
        id: c.id,
        text: c.text || '',
        author: c.author?.fullName || c.author?.login || null,
        created: c.created ? new Date(c.created).toISOString() : null,
    }));
}

/** @param {YoutrackCreds} creds */
async function listProjects(creds,{ limit = 50 } = {}) {
    const params = new URLSearchParams({
        fields: 'id,name,shortName',
        $top: String(Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)),
    });
    const projects = await youtrackRequest(creds.baseUrl, creds.token, 'GET', `/admin/projects?${params}`);
    if (!Array.isArray(projects)) return [];
    return projects.map(p => ({ id: p.id, name: p.name, shortName: p.shortName }));
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Create an issue, with the dedup dance around it.
 *
 * Resolves to { id, summary, alreadyExists?, verifiedAfterError? } or throws.
 * `alreadyExists` means nothing was created because an issue with this exact
 * summary is already there — the caller links that one instead.
 * @param {YoutrackCreds} creds
 * @param {{ projectId: string, summary: string, description?: string, allowDuplicate?: boolean }} opts
 */
async function createIssue(creds, { projectId, summary, description = '', allowDuplicate = false }) {
    if (!projectId) throw new Error('projectId is required');
    if (!summary) throw new Error('summary is required');

    const requestStart = Date.now();
    const shortName = allowDuplicate ? null : await resolveProjectShortName(creds, projectId);

    if (shortName) {
        const existing = await findRecentIssueBySummary(creds, shortName, summary);
        if (existing) {
            return {
                alreadyExists: true,
                id: existing.idReadable,
                summary: existing.summary,
                created: existing.created ? new Date(existing.created).toISOString() : null,
            };
        }
    }

    try {
        const params = new URLSearchParams({ fields: 'idReadable,summary' });
        const issue = await youtrackRequest(creds.baseUrl, creds.token, 'POST', `/issues?${params}`, {
            summary,
            description: description || '',
            project: { id: projectId },
        });
        if (!issue) throw new Error('YouTrack returned no issue — check the project id');
        return { id: issue.idReadable || issue.id, summary: issue.summary };
    } catch (err) {
        // Timeouts, dropped connections and 5xx are ambiguous: YouTrack may
        // have committed the issue anyway. Verify by search before reporting a
        // failure, or the caller retries and we get two issues for one ticket.
        const ambiguous = err.code === 'ETIMEDOUT' || err.code === 'EREQUEST' || (err.status >= 500);
        if (ambiguous) {
            await sleep(VERIFY_DELAY_MS);
            const verifyShortName = shortName || await resolveProjectShortName(creds, projectId);
            const found = await findRecentIssueBySummary(creds, verifyShortName, summary, {
                createdAfterMs: requestStart - 60_000,
            });
            if (found) {
                log.info(`[YouTrack] Create verified after error — issue exists as ${found.idReadable}`);
                return { id: found.idReadable, summary: found.summary, verifiedAfterError: true };
            }
        }
        throw err;
    }
}

/**
 * @param {YoutrackCreds} creds
 * @param {string} issueId
 * @param {string} text
 */
async function addComment(creds, issueId, text) {
    if (!ISSUE_ID_RE.test(issueId || '')) throw new Error('invalid issue id');
    if (!text) throw new Error('text is required');
    await youtrackRequest(creds.baseUrl, creds.token, 'POST', `/issues/${issueId}/comments`, { text });
    return true;
}

/**
 * Add a tag. Best-effort: a tag the instance forbids must not fail the create.
 * @param {YoutrackCreds} creds
 * @param {string} issueId
 * @param {string} tag
 */
async function addTag(creds, issueId, tag) {
    if (!ISSUE_ID_RE.test(issueId || '')) throw new Error('invalid issue id');
    if (!tag || !/^[A-Za-z0-9 :._-]{1,80}$/.test(tag)) throw new Error('invalid tag');
    await youtrackRequest(creds.baseUrl, creds.token, 'POST', '/commands', {
        query: `tag ${tag}`,
        issues: [{ idReadable: issueId }],
    });
    return true;
}

/**
 * @param {string} baseUrl
 * @param {string} issueId
 */
function issueUrl(baseUrl, issueId) {
    if (!baseUrl || !ISSUE_ID_RE.test(issueId || '')) return null;
    return `${baseUrl.replace(/\/+$/, '')}/issue/${issueId}`;
}

module.exports = {
    // keys, so the admin routes and the tool file agree on where secrets live
    SERVICE_URL_KEY,
    SERVICE_TOKEN_KEY,
    SERVICE_PROJECT_KEY,
    ISSUE_ID_RE,

    youtrackRequest,
    resolveCredentials,
    getDefaultProject,
    ping,

    normalizeSummary,
    resolveProjectShortName,
    findRecentIssueBySummary,

    shapeIssue,
    searchIssues,
    getIssue,
    getIssuesByIds,
    getIssueComments,
    listProjects,

    createIssue,
    addComment,
    addTag,
    issueUrl,

    __setVerifyDelayMs,
    __verifyDelayMs,
};
