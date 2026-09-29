/**
 * The environment an MCP child process is allowed to see.
 *
 * WHY THIS EXISTS
 * Both spawn sites in core/mcpManager.js built the child's environment as
 * `{ ...process.env, ...userEnv }`. That hands a third-party program every
 * variable the server holds: DATABASE_URL, MASTER_ENCRYPTION_KEY,
 * OPAQUE_SERVER_SETUP, provider API keys, licence secrets, session secrets.
 *
 * An MCP server is not our code. Many are `npx <package>`, which downloads and
 * runs whatever that name resolves to at the moment of the call. So the process
 * that gets the database password is a program fetched from the internet during
 * the request — and it does not need the database password to do its job.
 *
 * Inheritance was never a decision; it is what the spread operator does by
 * default. This file makes it one.
 *
 * ── ALLOW-LIST, NOT DENY-LIST ────────────────────────────────────────
 * A deny-list of "sensitive" names loses the moment somebody adds
 * `STRIPE_SECRET` or `SMTP_PASSWORD` to the server's environment: the new
 * variable is not on the list, so it leaks, and nothing fails. The same
 * reasoning CLAUDE.md applies to outbound payloads — build from an explicit
 * allow-list of fields, never by removing keys from a row.
 *
 * What survives is the small set a child genuinely needs to RUN: where its
 * interpreter lives, where its home and temp directories are, and the proxy and
 * locale settings that make network calls and text handling behave. Everything
 * a server needs to be Bee Flow stays behind.
 *
 * Credentials the MCP server actually requires still reach it — through
 * `userEnv`/`envVars`, which is the per-server credential map an operator
 * configured on purpose. That path is unchanged; this only stops the ambient
 * leak underneath it.
 */

'use strict';

/**
 * Variables an ordinary child process needs in order to start and behave.
 * Exact names only — no prefixes, no patterns. A pattern is a deny-list in
 * disguise: `*_URL` would have passed DATABASE_URL straight through.
 */
const ALLOWED_ENV = Object.freeze([
    // Where to find executables, and the platform's idea of "here".
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'COMSPEC',
    // Home and scratch space. A child that cannot write a temp file fails in
    // ways that look like our bug.
    'HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP',
    // Locale and encoding: without these, output arrives mojibaked.
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    // Outbound network policy. A self-host behind a corporate proxy needs
    // these or every MCP server that talks to the internet hangs.
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
    // Node and npm runtime knobs, for the `npx …` servers that are the common
    // case. NODE_OPTIONS is deliberately NOT here: it can inject a --require
    // module into the child.
    'NODE_ENV', 'NPM_CONFIG_CACHE', 'NPM_CONFIG_PREFIX', 'NPM_CONFIG_REGISTRY',
    // Terminal shape, so tools that format output do not assume 80x24.
    'TERM', 'COLUMNS', 'LINES',
]);

const ALLOWED = new Set(ALLOWED_ENV);

/**
 * Build the environment for an MCP child.
 *
 * @param {object} extra  per-server credentials an operator configured
 * @param {object} [source=process.env]  the parent environment
 * @returns {object} a fresh object — never a reference into process.env
 */
function buildMcpChildEnv(extra = {}, source = process.env) {
    const env = {};
    for (const name of ALLOWED_ENV) {
        const value = source[name];
        // Skip undefined, keep empty strings: `NO_PROXY=` is a meaningful
        // setting and is not the same as unset.
        if (value !== undefined) env[name] = value;
    }
    // The operator's own credential map goes on top and may override anything
    // above — that is the configured, intentional channel.
    for (const [k, v] of Object.entries(extra || {})) {
        if (v !== undefined && v !== null) env[k] = String(v);
    }
    return env;
}

module.exports = { ALLOWED_ENV, ALLOWED, buildMcpChildEnv };
