// @typecheck strict
/** @typedef {import('./youtrackClient').YoutrackCreds} YoutrackCreds */
const configStore = require('../stores/configStore');
const { jsonApiRequest } = require('./shared/apiClient');
const log = require('../telemetry/log');

// configStore keys. The service pair is written by the support admin UI; the
// per-user pair predates it and is still what the agent tools use.
const SERVICE_URL_KEY = 'youtrack_url_support';

const SERVICE_TOKEN_KEY = 'youtrack_token_support';

const SERVICE_PROJECT_KEY = 'youtrack_project_support';

// Issue ids are interpolated into REST paths and into the commands
// mini-language, where an unvalidated value could smuggle in extra commands.
// Every entry point that takes one validates against this.
const ISSUE_ID_RE = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

// `commentsCount` is what lets a caller find the newest comment: the comments
// endpoint lists oldest first and takes no sort, so the count is the offset.
const FIELDS_ISSUE_SHORT = 'idReadable,summary,created,updated,resolved,commentsCount,customFields(name,value(name))';

const FIELDS_ISSUE_FULL = `${FIELDS_ISSUE_SHORT},description,reporter(login,fullName)`;

/**
 * One request against a YouTrack REST endpoint. SSRF pre-filter on the
 * configured base URL, mandatory timeout, error bodies truncated so no URL or
 * token can reach a log line or a model. YouTrack always answers JSON, so this
 * resolves to parsed JSON or null.
 * @param {string} baseUrl
 * @param {string} token
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<any>}
 */
async function youtrackRequest(baseUrl, token, method, path, body = null) {
    const url = `${baseUrl.replace(/\/+$/, '')}/api${path}`;
    return jsonApiRequest(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        body: body || undefined,
        errorPrefix: 'YouTrack API',
    });
}

/**
 * Resolve a usable (baseUrl, token) pair.
 *
 * Service connection first, the caller's own second. `source` says which won,
 * so a caller can tell an admin why a call behaved the way it did.
 *
 * @param {object}  [opts]
 * @param {?string} [opts.userId]       fall back to this user's own token
 * @param {boolean} [opts.serviceOnly]  never fall back (background jobs: there
 *                                    is no user, and silently borrowing one
 *                                    person's token for a shared poller would
 *                                    make the whole hub depend on them)
 */
async function resolveCredentials({ userId = null, serviceOnly = false } = {}) {
    const baseUrl = await configStore.getSecret(SERVICE_URL_KEY);
    const token = await configStore.getSecret(SERVICE_TOKEN_KEY);
    if (baseUrl && token) return { baseUrl, token, source: 'service' };
    if (serviceOnly || !userId) return null;

    const userUrl = await configStore.getSecret(`youtrack_url_user_${userId}`);
    const userToken = await configStore.getSecret(`youtrack_token_user_${userId}`);
    if (userUrl && userToken) return { baseUrl: userUrl, token: userToken, source: 'user' };
    return null;
}

/** The default project new issues land in, or null when unset. */
async function getDefaultProject() {
    const v = await configStore.getSecret(SERVICE_PROJECT_KEY);
    return v || null;
}

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {unknown} s */
function normalizeSummary(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Callers routinely hold a shortName where the database id belongs; when the
 * admin lookup fails, treat the given value as the shortName.
 * @param {YoutrackCreds} creds
 * @param {string} projectId
 */
async function resolveProjectShortName({ baseUrl, token }, projectId) {
    if (!projectId) return null;
    try {
        const params = new URLSearchParams({ fields: 'id,shortName' });
        const project = await youtrackRequest(baseUrl, token, 'GET', `/admin/projects/${encodeURIComponent(projectId)}?${params}`);
        if (project?.shortName) return project.shortName;
    } catch (err) {
        log.warn(`[YouTrack] Project lookup failed for "${projectId}": ${/** @type {Error} */ (err).message}`);
    }
    return /^[A-Za-z][A-Za-z0-9_]*$/.test(projectId) ? projectId : null;
}

module.exports = { SERVICE_URL_KEY, SERVICE_TOKEN_KEY, SERVICE_PROJECT_KEY, ISSUE_ID_RE, FIELDS_ISSUE_SHORT, FIELDS_ISSUE_FULL, youtrackRequest, resolveCredentials, getDefaultProject, sleep, normalizeSummary, resolveProjectShortName };
