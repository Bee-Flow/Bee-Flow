#!/usr/bin/env node
'use strict';
// bee-flow-healthcheck-wget
//
// Installed as /usr/local/bin/wget in the server image. The image ships no
// wget or curl (scripts/check-release-container.sh), but compose files from
// releases up to 2026-09 check the server with
//   wget -q --spider http://localhost:3001/api/health
// and gate the other services on that check. Without this stand-in an
// operator who keeps the old compose file sees `server` unhealthy forever and
// the services that wait for it never start.
//
// Deliberately not a download tool: it only answers a GET to localhost,
// writes nothing, and refuses everything else.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** @param {string[]} argv @returns {URL | null} */
function parseTarget(argv) {
    const urls = argv.filter((a) => !a.startsWith('-'));
    if (urls.length !== 1) return null;
    let url;
    try { url = new URL(urls[0]); } catch { return null; }
    if (url.protocol !== 'http:' || !LOCAL_HOSTS.has(url.hostname)) return null;
    return url;
}

/** @param {string[]} argv @param {typeof fetch} [fetchImpl] @returns {Promise<number>} exit code */
async function run(argv, fetchImpl = fetch) {
    const url = parseTarget(argv);
    if (!url) {
        process.stderr.write('wget (healthcheck stand-in): only `wget -q --spider http://localhost:<port>/<path>` is supported\n');
        return 2;
    }
    try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
        return res.ok ? 0 : 8; // 8 = wget's "server issued an error response"
    } catch {
        return 4; // 4 = wget's "network failure"
    }
}

if (require.main === module) {
    run(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { parseTarget, run };
