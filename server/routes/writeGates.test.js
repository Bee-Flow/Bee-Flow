/**
 * Building and publishing are gated on a PERMISSION, not just on a capability.
 *
 * Two findings, one shape. `manage_apps` was registered in the permission
 * catalogue and enforced in exactly zero places — the checks lived in the
 * frontend. So on any org with the `app_studio`
 * capability, a plain member could create an app through the API, publish it to
 * the whole organisation, and mint a public internet URL for it. Self-hosted is
 * worse, because beta capabilities are granted org-wide to every member, so
 * narrowing by group does not help.
 *
 * The MCP server definitions had the same shape with a heavier consequence:
 * `requireAuth` plus a licence feature, on routes whose own comments said
 * "(admin)". A definition names a command the server spawns as a child process,
 * and an `npx`-based one is a package downloaded and executed at that moment.
 *
 * The tests read the route sources. That is on purpose: reaching these handlers
 * needs a session, an org, a licence and a database, and a test that mocks all
 * four proves the mocks agree with each other. What has to stay true is which
 * middleware sits on which route, and that is a property of the file.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

/**
 * The source a router declares its routes in — one file, or, when the router
 * is a FOLDER whose parts register onto one router, every .js under it.
 *
 * RECURSIVE on purpose. A one-level scan stops seeing a part the moment it
 * moves into a subfolder, and this test would keep passing while proving
 * nothing about the routes it no longer reads.
 */
function readRouter(rel) {
    const full = path.join(SERVER, rel);
    if (fs.statSync(full).isFile()) return fs.readFileSync(full, 'utf8');
    const parts = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const child = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(child); continue; }
            if (entry.name.endsWith('.js') && !entry.name.includes('.test.')) parts.push(fs.readFileSync(child, 'utf8'));
        }
    };
    walk(full);
    assert.ok(parts.length, `${rel} holds no route source — did the router move?`);
    return parts.join('\n');
}

/** Middleware named between the path and the handler of a route declaration. */
function middlewareFor(source, verb, routePath) {
    const re = new RegExp(
        `router\\.${verb}\\('${routePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}',([^]*?)(?:async\\s*)?\\(req, res\\)`,
    );
    const m = source.match(re);
    return m ? m[1] : null;
}

// ── App Studio: who may BUILD, as opposed to use ─────────────────────
const APPS = 'routes/studioApps.js';

const APP_WRITE_ROUTES = [
    ['post', '/'],
    ['put', '/:id'],
    ['put', '/:id/definition'],
    ['patch', '/:id/publish'],
    ['patch', '/:id/nextcloud-menu'],
    ['post', '/:id/public-pages'],
    ['delete', '/:id/public-pages/:token'],
    ['post', '/:id/template-upgrade'],
    ['delete', '/:id'],
    ['post', '/:id/versions/:versionId/restore'],
    ['delete', '/templates/:templateId'],
];

test('every App Studio write and publish route requires manage_apps', () => {
    const src = read(APPS);
    for (const [verb, routePath] of APP_WRITE_ROUTES) {
        const mw = middlewareFor(src, verb, routePath);
        assert.ok(mw !== null, `route ${verb.toUpperCase()} ${routePath} not found — did it move?`);
        assert.match(
            mw,
            /requireManageApps/,
            `${verb.toUpperCase()} ${routePath} does not require manage_apps. The mount only proves the `
            + 'installation HAS App Studio, not that this person may publish with it.',
        );
    }
});

// Playbooks create a routine, a table and an app on the caller's behalf —
// the same authoring permission gates every write (2026-09-13).
// A folder since the router was split per resource group; readRouter reads
// every part, so a route moving between them cannot slip past this gate.
const PLAYBOOKS = 'routes/playbooks';
const PLAYBOOK_WRITE_ROUTES = [
    ['post', '/'],
    ['patch', '/:id'],
    ['post', '/recipes/compose'],
    ['post', '/:id/phases/:key/run'],
    ['post', '/:id/phases/:key/skip'],
    ['post', '/:id/phases/:key/retry'],
    ['delete', '/:id'],
];

test('every Playbooks write route requires manage_apps', () => {
    const src = readRouter(PLAYBOOKS);
    for (const [verb, routePath] of PLAYBOOK_WRITE_ROUTES) {
        const mw = middlewareFor(src, verb, routePath);
        assert.ok(mw !== null, `route ${verb.toUpperCase()} ${routePath} not found — did it move?`);
        assert.match(mw, /requireManageApps/, `${verb.toUpperCase()} ${routePath} does not require manage_apps.`);
    }
});

test('manage_apps is enforced somewhere, not only registered', () => {
    // The finding in one line: the permission existed in the catalogue and had
    // no enforcement site at all.
    const src = read(APPS);
    assert.match(
        src,
        /requirePermission\('manage_apps'\)/,
        'no route module turns manage_apps into an actual check',
    );
});

test('the org role policy actually grants manage_apps, to the authoring roles and not to members', () => {
    // The other half of the gate. It went in on 2026-09-09 on the belief that
    // config/orgRoles.json already handed manage_apps out. It did not — no role
    // carried it — so until 2026-09-12 only a platform super-admin could create,
    // save or publish an app, and an org admin arriving through the Nextcloud
    // connector got "Permission 'manage_apps' required" on a blank New-app form.
    // A gate on a permission nobody holds is not access control, it is an outage.
    //
    // Building an app is authoring, like building an agent: whoever may manage
    // agents may manage apps, and nobody else. Tying the two keeps a future role
    // from getting one without the other.
    const policy = JSON.parse(read('config/orgRoles.json'));
    for (const [role, def] of Object.entries(policy)) {
        const perms = def.permissions || [];
        assert.equal(
            perms.includes('manage_apps'),
            perms.includes('manage_agents'),
            `${role}: manage_apps and manage_agents disagree — building an app is authoring, like building an agent`,
        );
    }
    for (const role of ['org_admin', 'agent_admin', 'agent_editor']) {
        assert.ok(policy[role].permissions.includes('manage_apps'), `${role} cannot build apps`);
    }
    // ...and NOT a plain member: that was the finding.
    assert.ok(!policy.member.permissions.includes('manage_apps'), 'a plain member may build and publish apps again');
});

test('reading and running an app stay on the capability', () => {
    // Using what somebody else built is the ordinary case. Gating reads on
    // manage_apps would lock every member out of the apps made for them.
    const src = read(APPS);
    for (const [verb, routePath] of [['get', '/'], ['get', '/mine'], ['get', '/:id'], ['get', '/:id/runtime']]) {
        const mw = middlewareFor(src, verb, routePath);
        assert.ok(mw !== null, `route ${verb.toUpperCase()} ${routePath} not found`);
        assert.ok(
            !/requireManageApps/.test(mw),
            `${verb.toUpperCase()} ${routePath} now demands manage_apps, which locks ordinary members `
            + 'out of apps that were built for them',
        );
    }
});

// ── MCP server definitions: closer to "run this program" ─────────────
const MCP = 'routes/ai/config/integrations.js';

const MCP_WRITE_ROUTES = [
    ['post', '/mcp-servers'],
    ['post', '/mcp-servers/test'],
    ['put', '/mcp-servers/:id'],
    ['delete', '/mcp-servers/:id'],
    ['post', '/mcp-servers/:id/refresh'],
];

test('defining or changing an MCP server requires a platform admin', () => {
    const src = read(MCP);
    for (const [verb, routePath] of MCP_WRITE_ROUTES) {
        const mw = middlewareFor(src, verb, routePath);
        assert.ok(mw !== null, `route ${verb.toUpperCase()} ${routePath} not found — did it move?`);
        assert.match(
            mw,
            /requireSuperAdmin/,
            `${verb.toUpperCase()} ${routePath} has no admin gate. requireAuth plus a licence feature is `
            + 'not one: on an Enterprise licence that is every signed-in user, and the definition names '
            + 'a command the server will spawn.',
        );
    }
});

test('an MCP definition is gated on the PLATFORM admin, not an org admin', () => {
    // The definitions are instance-wide. An org admin in one tenant would
    // otherwise be configuring code execution for every tenant on the box.
    const src = read(MCP);
    const mw = middlewareFor(src, 'post', '/mcp-servers');
    assert.ok(!/requirePrimaryOrgAdmin|requireOrgAdmin/.test(mw || ''), 'org-scoped gate on an instance-wide resource');
});

test('listing servers and saving your own credential stay open to ordinary users', () => {
    const src = read(MCP);
    // The picker needs the list.
    const list = middlewareFor(src, 'get', '/mcp-servers');
    assert.ok(list !== null && !/requireSuperAdmin/.test(list), 'reading the server list now needs an admin');
    // This writes the CALLER'S OWN credential for a server an admin defined.
    const creds = middlewareFor(src, 'post', '/mcp-servers/user-credentials');
    assert.ok(
        creds !== null && !/requireSuperAdmin/.test(creds),
        'saving your own credential now needs an admin, which breaks every non-admin using an MCP server',
    );
});
