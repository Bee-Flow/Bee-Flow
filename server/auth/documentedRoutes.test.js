/**
 * Every /auth/... path the documentation names is a path the server serves.
 *
 * The docs described a SAML integration — an ACS URL, an SP entity ID, a
 * metadata-XML paste flow — that has never existed in any version of this
 * product. `sso_saml` is the name of a LICENCE CAPABILITY, and a whole page
 * grew around the word. Alongside it: eight per-provider OAuth paths
 * (/auth/google/login, /auth/github/callback, …) that were replaced by the
 * provider-parameterised pair years ago, and a GitHub OAuth App flow with
 * environment variables nothing reads.
 *
 * A customer configuring an identity provider from those pages gets a login
 * that cannot work. A customer writing an ISO access-control policy from them
 * documents a control they do not have — which is the worse of the two, because
 * it survives until an auditor asks.
 *
 * So: extract the /auth/... paths from the docs and check each against the
 * mounted router. Prose is not tested; a path in a fenced block or a table is.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const DOCS = path.join(REPO, 'docs/docs');

/** Every literal /auth/... path mentioned in the docs, with where it was found. */
function documentedAuthPaths() {
    const found = new Map();
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
            const src = fs.readFileSync(full, 'utf8');
            for (const m of src.matchAll(/\/auth\/[a-zA-Z0-9/_:-]+/g)) {
                // Trailing punctuation from prose and table cells, and the
                // trailing slash left when a path ends in a `<provider>`
                // placeholder the character class stops at.
                const p = m[0].replace(/[.,)`|]+$/, '').replace(/\/$/, '');
                // `server/auth/connectorJwt.js` in a source link is a file
                // path, not a route — the two only look alike. Anything the
                // page introduces with `server` immediately before it is the
                // former.
                if (src.slice(Math.max(0, m.index - 6), m.index) === 'server') continue;
                if (!found.has(p)) found.set(p, path.relative(REPO, full));
            }
        }
    };
    walk(DOCS);
    return found;
}

/**
 * The paths the auth tree actually serves, as express route patterns relative
 * to the /auth mount.
 *
 * Read from the SOURCE rather than by walking router.stack: Express 5 keeps a
 * mounted sub-router's prefix only inside its matcher functions, so a runtime
 * walk silently drops the one prefixed mount here (`/opaque`) and would report
 * every OPAQUE path as served whatever it was called. Parsing the mounts and
 * the route declarations keeps the prefix, and a wrong answer shows up as a
 * name in the failure message instead of as a false pass.
 */
function servedAuthPaths() {
    const AUTH = __dirname;
    const out = new Set();

    // router.use('<prefix>', require('./x')) in auth/index.js — the prefix a
    // sub-router's own paths hang under.
    const index = fs.readFileSync(path.join(AUTH, 'index.js'), 'utf8');
    const prefixOf = new Map();
    for (const m of index.matchAll(/router\.use\(\s*'([^']*)'\s*,\s*require\('\.\/([\w./-]+)'\)/g)) {
        prefixOf.set(m[2].replace(/\.js$/, ''), m[1] === '/' ? '' : m[1]);
    }

    const declaredIn = (file, prefix) => {
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*'([^']+)'/g)) {
            out.add((prefix + m[2]).replace(/\/+/g, '/'));
        }
    };

    const walk = (dir, prefix) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full, prefix); continue; }
            if (!entry.name.endsWith('.js') || entry.name.includes('.test.')) continue;
            const rel = path.relative(AUTH, full).replace(/\.js$/, '').replace(/\\/g, '/');
            // A file mounted under a prefix in index.js carries it; anything it
            // mounts in turn is treated as sharing it, which is true here and
            // fails loudly (a ghost) rather than quietly if it stops being.
            declaredIn(full, prefixOf.has(rel) ? prefixOf.get(rel) : prefix);
        }
    };
    walk(AUTH, '');

    // server/auth/ is not the only thing mounted at /auth — index.js hangs the
    // Nextcloud webhook, sync and connector-health routers there too. Missing
    // them would report their paths as ghosts, so the sweep would be trained
    // away rather than fixed.
    const server = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8');
    for (const m of server.matchAll(/app\.use\(\s*'\/auth'\s*,\s*require\('\.\/([\w./-]+)'\)/g)) {
        const file = path.join(REPO, 'server', m[1].replace(/\.js$/, '') + '.js');
        if (fs.existsSync(file)) declaredIn(file, '');
    }
    return out;
}

/** Does a documented path match a served route pattern (`:param` matches one segment)? */
function isServed(docPath, served) {
    const rel = docPath.replace(/^\/auth/, '') || '/';
    for (const pattern of served) {
        const rx = new RegExp('^' + pattern
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/:[\w]+/g, '[^/]+') + '$');
        // A documented path may itself carry a :param — then it must match a
        // pattern with a param in the same place, which the regex above allows
        // because ':provider' is a legal segment value.
        if (rx.test(rel)) return true;
    }
    return false;
}

test('every /auth path in the documentation is served by the auth router', () => {
    const served = servedAuthPaths();
    assert.ok(served.size > 5, 'the router walk found almost nothing — check the traversal');

    /**
     * Paths a page names ON PURPOSE in order to say they do NOT exist. Each one
     * is a warning that replaced a section describing a feature that was never
     * built, and the path has to be printed for the warning to be usable by
     * someone who followed the old instructions.
     *
     * This list is the only way past the sweep, which is the point: removing a
     * route now means either updating the page or writing down here, by name,
     * why the page still says it.
     */
    const NAMED_AS_ABSENT = new Map([
        ['/auth/github/callback', 'docs/docs/integrations/github.md — the OAuth App flow that never existed'],
        ['/auth/saml/acs', 'never implemented; see the SAML warning in api/auth.md'],
        ['/auth/saml/metadata', 'never implemented; see the SAML warning in api/auth.md'],
        ['/auth/nc-handshake', 'api/auth.md — the handshake endpoint the old diagram drew'],
    ]);
    const NOT_THIS_ROUTER = new Map([
        // The SPA's own client-side routes.
        ['/auth/login-error', 'a front-end screen, not a server route'],
    ]);

    const ghosts = [];
    for (const [docPath, where] of documentedAuthPaths()) {
        if (NOT_THIS_ROUTER.has(docPath) || NAMED_AS_ABSENT.has(docPath)) continue;
        if (!isServed(docPath, served)) ghosts.push(`${docPath}  (${where})`);
    }

    assert.deepStrictEqual(
        ghosts, [],
        'the documentation names /auth paths the server does not serve. Either the route was removed '
        + 'and the page was not, or the page describes something that was never built — and a customer '
        + 'configuring an identity provider from it gets a login that cannot work:\n' + ghosts.join('\n'),
    );
});

test('no page claims a SAML endpoint', () => {
    // Narrower than the sweep above and worth stating separately: SAML is the
    // one that ends up in an access-control policy rather than in a config
    // screen, so it is the one that survives longest before anyone notices.
    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdx')) continue;
            const src = fs.readFileSync(full, 'utf8');
            if (/\/saml\/(acs|metadata|sso|slo)/i.test(src)) offenders.push(path.relative(REPO, full));
        }
    };
    walk(DOCS);
    assert.deepStrictEqual(
        offenders, [],
        'these pages name a SAML endpoint. Bee Flow has no SAML implementation — `sso_saml` is a '
        + 'licence-capability identifier that gates the OIDC providers:\n' + offenders.join('\n'),
    );
});
