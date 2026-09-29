/**
 * Drift test — holds auth/accessRegistry.js to the app's REAL router stack.
 *
 * This is the mechanism that makes the registry trustworthy rather than prose.
 * Without it the registry is exactly what license/featureMap.js openly admits to
 * being: documentation that nothing enforces, and which drifts the moment
 * someone adds a route.
 *
 * It shells out to auth/routeWalk.cli.js (a child process — requiring index.js
 * starts module-scope timers that would hang `node --test`; see that file's
 * header) and asserts the registry against what actually got mounted.
 *
 * WHAT THIS CAN PROVE: that every route is accounted for; that a
 * `middleware`-enforced route's real tagged gate chain matches its declaration;
 * that a route claiming `public` really has no gate; that nobody added an
 * in-handler check to a route the registry calls `middleware`.
 *
 * WHAT IT CANNOT PROVE: that a `handler` entry's declared permission list is
 * CORRECT. Someone can drop 'org_admin' from adminRoutes.js:125 and this stays
 * green — the check still exists, it just accepts fewer people. That is
 * irreducible for static analysis. The mitigations, strongest first:
 *   (a) P4 converts important body gates to tagged middleware, moving them into
 *       the machine-verified column permanently;
 *   (b) every `handler` entry carries `verifiedBy`, asserted to exist below;
 *   (c) the manual curl cross-check in the plan's verification section.
 *
 * Run: cd server && node --test auth/accessRegistry.drift.test.js
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const registry = require('./accessRegistry');
const featureMap = require('../license/featureMap');

const SERVER = path.resolve(__dirname, '..');

let walk;
let byId;

before(() => {
    const outFile = path.join(os.tmpdir(), `bf-routewalk-${process.pid}.json`);
    try {
        execFileSync(process.execPath, [path.join(SERVER, 'auth', 'routeWalk.cli.js'), '--out', outFile], {
            cwd: SERVER,
            stdio: 'pipe',
            timeout: 120_000,
            env: {
                ...process.env,
                // The walk only needs the app to LOAD. A dummy secret keeps
                // the secret-box stores from throwing on require; it never
                // authenticates anything.
                SESSION_SECRET: process.env.SESSION_SECRET || 'drift-test-dummy-secret-0123456789-0123456789',
                NODE_ENV: 'test',
                OTEL_ENABLED: 'false',
            },
        });
        walk = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    } finally {
        try { fs.unlinkSync(outFile); } catch (_) { /* best effort */ }
    }
    byId = new Map(walk.routes.map((r) => [r.id, r]));
});

const isTriaged = (p) => registry.triagedPrefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
const gatesOf = (route) => route.chain.filter((c) => c.gate).map((c) => c.gate);
const nonAuthGates = (route) => gatesOf(route).filter((g) => g.axis !== 'auth');
const probed = (route) => route.handlerProbe.direct || route.handlerProbe.wrapper;

describe('the walk itself', () => {
    test('loaded the real app without a DB or a socket', () => {
        assert.ok(walk.stats.routes > 500, `expected the full app, got ${walk.stats.routes} routes`);
        assert.ok(walk.stats.mounts > 50, `expected many mounts, got ${walk.stats.mounts}`);
    });

    test('read every handler body — the probe has no blind spot', () => {
        // Function.prototype.toString on the handler the walker is holding. If
        // this ever drops below 100% the probe silently under-reports.
        assert.equal(walk.stats.probedHandlers, walk.stats.routes);
    });

    test('recovered the gate tags — without these the table is all "anonymous"', () => {
        assert.ok(walk.stats.taggedChainSlots > 500, `only ${walk.stats.taggedChainSlots} tagged slots`);
    });
});

// ═══ 1. No undeclared route ═════════════════════════════════════════
// The actual robustness mechanism: a new endpoint in a triaged prefix fails CI
// until someone says what it requires.
describe('1. every route in a triaged prefix is accounted for', () => {
    test('no route is silently unaccounted for', () => {
        const orphans = [];
        for (const route of walk.routes) {
            if (!isTriaged(route.path)) continue;
            if (registry.routes[route.id]) continue;
            if (registry.untriaged.includes(route.id)) continue;
            // A route whose chain carries a real (non-auth) tagged gate is
            // self-describing — the walk knows what it needs, no entry required.
            if (nonAuthGates(route).length > 0) continue;
            // Otherwise: requireAuth-only or ungated. That is fine ONLY if the
            // handler shows no gate-shaped call. If it does, it needs declaring.
            if (probed(route)) orphans.push(`${route.id} (probe: ${route.handlerProbe.hits.join(', ')})`);
        }
        assert.deepEqual(orphans, [], `these routes gate inside the handler but are not declared:\n  ${orphans.join('\n  ')}`);
    });
});

// ═══ 2. No stale entry ══════════════════════════════════════════════
describe('2. the registry does not describe routes that no longer exist', () => {
    test('every declared route is really mounted', () => {
        const stale = Object.keys(registry.routes).filter((id) => !byId.has(id));
        assert.deepEqual(stale, [], `registry describes routes that are not mounted: ${stale.join(', ')}`);
    });

    test('every untriaged entry is really mounted', () => {
        const stale = registry.untriaged.filter((id) => !byId.has(id));
        assert.deepEqual(stale, [], `untriaged lists routes that are not mounted: ${stale.join(', ')}`);
    });
});

// ═══ 3. Chain equivalence ═══════════════════════════════════════════
describe('3. a middleware-enforced route matches its declaration', () => {
    test('declared rbac permissions equal the real tagged chain', () => {
        for (const [id, entry] of Object.entries(registry.routes)) {
            if (entry.enforcement !== 'middleware') continue;
            const route = byId.get(id);
            const rbac = gatesOf(route).filter((g) => g.axis === 'rbac');
            const declared = [...(entry.rbac?.anyOf || [])].sort();
            const actual = [...new Set(rbac.flatMap((g) => g.anyOf || []))].sort();
            assert.deepEqual(actual, declared, `${id}: chain says ${JSON.stringify(actual)}, registry says ${JSON.stringify(declared)}`);
        }
    });
});

// ═══ 4. No untagged gate ════════════════════════════════════════════
// Enforceable only because the walker drops the terminal handler from the chain
// and separates app-level plumbing — otherwise no route could ever pass.
describe('4. every gate in a chain is self-describing', () => {
    test('no unrecognised untagged middleware in a triaged prefix', () => {
        const findings = [];
        for (const route of walk.routes) {
            if (!isTriaged(route.path)) continue;
            for (const slot of route.chain) {
                if (slot.gate) continue;
                if (registry.plumbingNames.includes(slot.name)) continue;
                if (slot.name === 'anonymous') continue; // covered by assertion 1 via the probe
                findings.push(`${route.id} → ${slot.name}`);
            }
        }
        assert.deepEqual(findings, [], `untagged, unrecognised middleware — tag it or add it to plumbingNames:\n  ${findings.join('\n  ')}`);
    });
});

// ═══ 5. Probe ⟷ enforcement agreement ═══════════════════════════════
describe('5. the declaration matches what the handler body actually does', () => {
    test('a route claiming `public` has no gate-shaped call in its body', () => {
        for (const [id, entry] of Object.entries(registry.routes)) {
            if (entry.enforcement !== 'public') continue;
            const route = byId.get(id);
            if (!route) continue;
            // `public` + a probe hit is allowed ONLY with an explicit note saying
            // why the hit is not authorization (e.g. signup policy). Silence is
            // not an acceptable answer here.
            if (probed(route)) {
                assert.ok(entry.note, `${id} is declared public but its body has a gate-shaped call (${route.handlerProbe.hits.join(', ')}) and no note explaining why that is not a gate`);
            }
        }
    });

    test('a route claiming `handler` really has a gate-shaped call', () => {
        for (const [id, entry] of Object.entries(registry.routes)) {
            if (entry.enforcement !== 'handler') continue;
            const route = byId.get(id);
            if (!route) continue;
            assert.ok(probed(route), `${id} is declared handler-gated, but its body shows no gate-shaped call — did the gate move to middleware? Update the registry.`);
        }
    });

    test('a route claiming `middleware` has NOT grown an in-handler check', () => {
        for (const [id, entry] of Object.entries(registry.routes)) {
            if (entry.enforcement !== 'middleware') continue;
            const route = byId.get(id);
            if (!route) continue;
            assert.ok(!route.handlerProbe.direct, `${id} is declared middleware-enforced but its body now makes a gate-shaped call (${route.handlerProbe.hits.join(', ')}) — the Access Map would under-report it`);
        }
    });
});

// ═══ 6. untriaged only shrinks ══════════════════════════════════════
describe('6. the unknown surface does not grow', () => {
    // Frozen at today's value: 24 /auth routes whose real gate lives in a handler
    // body. Lower it as you triage; NEVER raise it. Raising it is how a registry
    // quietly stops describing the app.
    const FROZEN_MAX = 24;
    test(`untriaged has at most ${FROZEN_MAX} entries`, () => {
        assert.ok(
            registry.untriaged.length <= FROZEN_MAX,
            `untriaged grew to ${registry.untriaged.length} (max ${FROZEN_MAX}). Triage the new routes rather than raising the cap.`,
        );
    });
});

// ═══ 7. featureMap parity ═══════════════════════════════════════════
// license/featureMap.js:21-23 asks for this by name: "To audit drift, compare
// Object.keys(featureMap) against the mount paths registered in server/index.js
// (this is what the regression test planned for Wave 3 will do once the harness
// exists)." The harness now exists.
describe('7. license/featureMap describes real mounts', () => {
    const mountedSet = () => new Set(walk.mounts.map((m) => m.path));
    const allPaths = () => walk.routes.map((r) => r.path);
    const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Some keys are glob patterns rather than literal mounts
    // (e.g. '/api/automation/*/share' documents a gate on a sub-path).
    const isMounted = (key) => {
        if (key.includes('*')) {
            const rx = new RegExp(`^${key.split('*').map(escapeRx).join('[^/]+')}`);
            return allPaths().some((p) => rx.test(p));
        }
        return mountedSet().has(key) || allPaths().some((p) => p === key || p.startsWith(`${key}/`));
    };

    // featureMap deliberately reserves gates for routes that do not exist yet —
    // e.g. '/api/automation/*/share' notes "Not yet mounted." Those are
    // intentional, so the check is bidirectional rather than one-way.
    const isReserved = (entry) => /not yet mounted/i.test(entry?.notes || '');

    test('every non-reserved featureMap key is a mounted path', () => {
        const missing = Object.entries(featureMap)
            .filter(([k, entry]) => !isReserved(entry) && !isMounted(k))
            .map(([k]) => k);
        assert.deepEqual(missing, [], `featureMap describes paths that are not mounted (add "Not yet mounted." to notes if that is deliberate): ${missing.join(', ')}`);
    });

    test('a featureMap key marked "not yet mounted" really is not mounted', () => {
        // The other direction: once someone mounts a reserved route, the note is
        // a lie and the gate silently stops being reviewed. This catches that.
        const nowMounted = Object.entries(featureMap)
            .filter(([k, entry]) => isReserved(entry) && isMounted(k))
            .map(([k]) => k);
        assert.deepEqual(nowMounted, [], `featureMap claims these are "not yet mounted" but they are now mounted — drop the note and confirm the gate: ${nowMounted.join(', ')}`);
    });
});

// ═══ 8. handler entries name a test that verifies their meaning ═════
describe('8. what the drift test cannot verify, a named test does', () => {
    test('every `handler` entry with an rbac claim names an existing verifiedBy test', () => {
        for (const [id, entry] of Object.entries(registry.routes)) {
            if (entry.enforcement !== 'handler') continue;
            if (!entry.rbac) continue; // no permission claim → nothing to verify
            assert.ok(entry.verifiedBy, `${id} declares an rbac list this test cannot verify; name the authz test in verifiedBy`);
            assert.ok(
                fs.existsSync(path.join(SERVER, entry.verifiedBy)),
                `${id}: verifiedBy points at ${entry.verifiedBy}, which does not exist`,
            );
        }
    });
});

// ═══ 9. Platform surfaces carry a platform gate ═════════════════════
// The one assertion that would have caught the 2026-08-10 pentest finding on
// the day the code was written, without anyone reasoning about permission
// semantics: routes/adminLicense.js was mounted under /api/admin/licenses with
// an rbac gate ('manage_users'), and config/orgRoles.json hands that permission
// to every org_admin. This fails at the MOUNT, before any of that matters.
//
// Assertions 1-8 verify that the registry describes the app. This one asserts a
// property of the app itself: a route that reshapes the whole installation must
// be gated on who operates the installation, never on what someone may do
// inside a tenant.
describe('9. install-wide surfaces are gated on platform role, not on a permission', () => {
    // Prefixes whose routes govern the INSTALLATION: licence issuance, module
    // import, instance-wide signup/SSO policy, the global role table. Adding a
    // prefix here is how you make a surface operator-only and keep it that way.
    const PLATFORM_PREFIXES = [
        '/api/admin/licenses',
        '/api/admin/modules',
        '/auth/admin/signup-settings',
        '/auth/admin/waitlist',
        '/auth/settings',
        '/auth/oauth-config',
        '/auth/free-email-domains',
        '/auth/default-integrations',
        '/auth/connector-provisioning-mode',
    ];
    const underPlatformPrefix = (p) =>
        PLATFORM_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));

    test('every platform-prefixed route carries a platform gate', () => {
        const ungated = [];
        for (const route of walk.routes) {
            if (!underPlatformPrefix(route.path)) continue;
            if (!gatesOf(route).some((g) => g.axis === 'platform')) {
                ungated.push(`${route.id} → [${nonAuthGates(route).map((g) => g.axis).join(', ') || 'no gate'}]`);
            }
        }
        assert.deepEqual(ungated, [], `these install-wide routes are not gated on platform role:\n  ${ungated.join('\n  ')}`);
    });

    test('no platform-prefixed route is gated on an rbac permission instead', () => {
        // The specific failure mode: an rbac gate LOOKS like authorization and
        // passes review, but 'manage_users' / 'all' are both reachable from
        // inside a tenant. A platform route must not lean on either.
        const rbacGated = [];
        for (const route of walk.routes) {
            if (!underPlatformPrefix(route.path)) continue;
            const rbac = gatesOf(route).filter((g) => g.axis === 'rbac');
            if (rbac.length > 0) {
                rbacGated.push(`${route.id} → rbac ${JSON.stringify(rbac.map((g) => g.anyOf || g.id))}`);
            }
        }
        assert.deepEqual(rbacGated, [], `install-wide routes gated on a tenant-reachable permission:\n  ${rbacGated.join('\n  ')}`);
    });

    test('the platform prefixes actually exist — no dead entries', () => {
        // A typo'd prefix would silently assert nothing at all.
        const dead = PLATFORM_PREFIXES.filter(
            (prefix) => !walk.routes.some((r) => r.path === prefix || r.path.startsWith(`${prefix}/`)),
        );
        assert.deepEqual(dead, [], `these prefixes match no mounted route: ${dead.join(', ')}`);
    });
});

describe('10. every optional module owns at least one module-gated route', () => {
    // The point of the platform-module layer is that a de-imported module's
    // routes 404. A catalog entry whose routes carry only a capability gate
    // still DENIES — the registry projection drops its capability ids — but it
    // denies with 403 feature_locked, which advertises the surface instead of
    // concealing it. That is how /ai/learning and the approvals browse routes
    // sat for a while: correct-looking, off-contract, and invisible without a
    // walk of the real stack.
    //
    // Deliberately a floor, not an inventory: it asserts the wiring EXISTS per
    // module, and does not pin how many routes each one covers, so ordinary
    // route churn cannot fail it.
    const { listModules } = require('../modules/catalog');

    const moduleGateIds = new Set(
        walk.routes.flatMap((r) => gatesOf(r).filter((g) => g.axis === 'module').map((g) => g.id)),
    );

    test('the walk sees module gates at all', () => {
        assert.ok(moduleGateIds.size > 0, 'no module gates in the walk — routeWalk or tagGate has gone stale');
    });

    test('each catalog module gates something', () => {
        const orphans = listModules().map((m) => m.id).filter((id) => !moduleGateIds.has(id));
        assert.deepEqual(orphans, [], `these modules cannot be switched off at the route layer: ${orphans.join(', ')}`);
    });

    test('no module gate names an id the catalog does not have', () => {
        // requireModule() throws at mount for an unknown built-in id, so this
        // can only fail via a remote gate ({ remote: true }) wired to a slug
        // that never arrives — worth catching here rather than in production.
        const known = new Set(listModules().map((m) => m.id));
        const unknown = [...moduleGateIds].filter((id) => !known.has(id));
        assert.deepEqual(unknown, [], `module gates reference unknown ids: ${unknown.join(', ')}`);
    });
});
