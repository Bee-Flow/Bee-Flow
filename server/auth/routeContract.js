// @typecheck strict
/**
 * Route contract — the gate class every route is held to.
 *
 * auth/accessRegistry.sweep.test.js proves ACCOUNTABILITY: every route has a
 * gate somewhere, a declaration, or an exemption with a reason. That answers
 * "is there a gate?" and not "which one?": a route that moves from a platform
 * gate to an org-level permission, or from a permission to a bare session, is
 * still accounted for and the sweep stays green. The contract pins the CLASS:
 * auth/routes.contract.json records, per route, the strongest gate the walked
 * middleware chain carries, and routes.contract.test.js fails when the chain
 * now carries a weaker one.
 *
 * Inputs are the two readings the repo already makes of the router:
 *   - the walk of the real app (scripts/api-reference-walk.cjs, through
 *     scripts/gen-api-reference.mjs walkServer): per route the TAGGED gates
 *     (auth/gateMeta.js) and the names of untagged middleware;
 *   - the static sweep (testUtils/routeSurfaceSweep.js) for routes with no
 *     tagged gate: evidence of a gate in the handler body, a registry entry, or
 *     an exemption in auth/openRoutes.js.
 *
 * Classes, weakest first. The rank is what the test compares; the label is what
 * the contract file shows.
 *   unaccounted   nothing anywhere — never allowed in the contract
 *   open          deliberately reachable without a gate; carries a reason
 *   handler       the gate is decided in the handler body (sweep evidence, a
 *                 registry declaration, or an untriaged registry entry)
 *   auth          a session is required (tagged auth axis)
 *   middleware    an untagged middleware whose name says it decides who the
 *                 caller is (requireAdmin, apiKeyAuth, …); at least a session
 *   scope         org membership or org-admin over a parameter (tagged)
 *   scoped        a grade on the resource (tagged, minGrade)
 *   permission    a SYSTEM_PERMISSIONS id (tagged rbac; `anyOf` kept so a
 *                 widened list is also a weakening)
 *   platform      a platform-level gate (tagged: kind superAdmin today; a
 *                 platform-admin helper that passes org admins only on a
 *                 self-hosted install tags itself with the same axis)
 *
 * Pure: nothing here reads a file or loads the app. The callers supply the walk
 * and the surface.
 */

'use strict';

/** @typedef {{ axis: string, kind?: string, anyOf?: string[], minGrade?: string, id?: string, param?: string, platform?: boolean }} GateTag */
/** @typedef {{ method: string, path: string, gates: GateTag[], middleware: Array<string | { name: string }>, probedHandler?: boolean }} WalkedRoute */
/** @typedef {{ gate: string, anyOf?: string[], reason?: string, via?: string }} ContractEntry */
/** @typedef {{ routes: Array<{ method: string, path: string, evidence: string[], file: string }> }} SurfaceLike */
/** @typedef {{ routes?: Record<string, { enforcement?: string, note?: string }>, untriaged?: string[] }} RegistryLike */
/** @typedef {Map<string, string | { reden: string }>} OpenMap */

/** @type {Readonly<Record<string, number>>} */
const RANK = Object.freeze({
    unaccounted: -1,
    open: 0,
    handler: 1,
    untriaged: 1,
    auth: 2,
    middleware: 2,
    scope: 3,
    scoped: 3,
    permission: 3,
    platform: 4,
});

// An untagged middleware that decides WHO the caller is, by its name. Same
// vocabulary as the sweep's AUTH_GATE_RX, plus the chat/monitoring gates the
// walk reports by name. Entitlement, feature, format and hydration middleware
// is deliberately left out: it never asks for an identity.
const IDENTITY_MW = /^_{0,2}(?:require(?!Module$|NcOrg$|ActiveOrg|Capability$|Feature$|License|Tier$|Beta|Json$|Mirror$|Cloud$)[A-Z]\w*|apiKeyAuth|attachOrgFilter|stageAuthMw|[A-Za-z]*(?<!Feature|training|stageFeature|customIntegrationsFeature)Gate)$/;

const routeId = (/** @type {{ method: string, path: string }} */ r) => `${r.method} ${r.path}`;

/** @param {string | { name?: string }} m */
function mwName(m) {
    return typeof m === 'string' ? m : (m && m.name) || '';
}

/**
 * The class the TAGGED chain and the named middleware give a route, or null
 * when the chain carries no identity gate at all.
 * @param {WalkedRoute} route
 * @returns {ContractEntry | null}
 */
function chainClass(route) {
    const tags = route.gates || [];
    // The platform axis, or an rbac gate that marks itself platform-wide
    // (auth/requirePlatformAdmin.js: `platform: true`).
    const platform = tags.find((g) => g.axis === 'platform' || g.platform === true);
    if (platform) return { gate: 'platform', via: platform.kind || (platform.platform ? 'platformAdmin' : 'platform') };
    const rbac = tags.filter((g) => g.axis === 'rbac');
    if (rbac.length) {
        // Several rbac gates AND together; the caller must satisfy each, so the
        // effective set is the narrowest. Keep the union for the widening check:
        // a route that drops one gate can only widen that union.
        const anyOf = [...new Set(rbac.flatMap((g) => g.anyOf || []))].sort();
        return { gate: 'permission', anyOf };
    }
    const scoped = tags.find((g) => g.axis === 'scoped');
    if (scoped) return { gate: 'scoped', via: scoped.minGrade || 'grade' };
    const scope = tags.find((g) => g.axis === 'scope');
    if (scope) return { gate: 'scope', via: scope.kind || 'scope' };
    if (tags.some((g) => g.axis === 'auth')) return { gate: 'auth' };
    const identity = (route.middleware || []).map(mwName).filter((n) => IDENTITY_MW.test(n));
    if (identity.length) return { gate: 'middleware', via: [...new Set(identity)].sort().join(',') };
    return null;
}

/**
 * The reason an exemption gives, whatever shape the map holds.
 * @param {string | { reden: string } | undefined} v
 */
function reasonOf(v) {
    if (!v) return '';
    return typeof v === 'string' ? v : v.reden;
}

/**
 * The exemption key that covers a route: the route itself, its file, or a mount prefix.
 * @param {string} id
 * @param {string} file
 * @param {string} routePath
 * @param {OpenMap} open
 */
function openKeyFor(id, file, routePath, open) {
    if (open.has(id)) return id;
    if (file && open.has(`file:${file}`)) return `file:${file}`;
    for (const key of open.keys()) {
        if (!key.startsWith('mount:')) continue;
        const pre = key.slice(6);
        if (routePath === pre || routePath.startsWith(`${pre}/`)) return key;
    }
    return null;
}

/**
 * Classify one walked route.
 * @param {WalkedRoute} route
 * @param {{ surface: SurfaceLike, registry: RegistryLike, open: OpenMap }} ctx
 * @returns {ContractEntry}
 */
function classify(route, { surface, registry, open }) {
    const fromChain = chainClass(route);
    if (fromChain) return fromChain;
    const id = routeId(route);
    const declared = (registry.routes || {})[id];
    if (declared) {
        // The registry's own drift test owns the wording of these notes.
        if (declared.enforcement === 'public') return { gate: 'open', reason: declared.note || '', via: 'registry' };
        return { gate: 'handler', via: `registry:${declared.enforcement || 'declared'}` };
    }
    if ((registry.untriaged || []).includes(id)) return { gate: 'untriaged' };
    const seen = surface.routes.find((s) => s.method === route.method && s.path === route.path);
    if (seen && seen.evidence.length) return { gate: 'handler', via: seen.evidence.join(',') };
    const key = openKeyFor(id, seen ? seen.file : '', route.path, open);
    if (key) return { gate: 'open', reason: reasonOf(open.get(key)) };
    if (route.probedHandler) return { gate: 'handler', via: 'probe' };
    return { gate: 'unaccounted' };
}

/**
 * The weakest reading of a route that the walk reports more than once (a
 * router mounted twice): the contract must hold at every mount.
 * @param {ContractEntry} a
 * @param {ContractEntry} b
 */
function weaker(a, b) {
    const ra = RANK[a.gate] ?? -1;
    const rb = RANK[b.gate] ?? -1;
    if (ra !== rb) return ra < rb ? a : b;
    if (a.gate === 'permission' && b.gate === 'permission') {
        const union = [...new Set([...(a.anyOf || []), ...(b.anyOf || [])])].sort();
        return { gate: 'permission', anyOf: union };
    }
    return a;
}

/**
 * Build the contract's route table from a walk.
 * @param {WalkedRoute[]} walked
 * @param {{ surface: SurfaceLike, registry: RegistryLike, open: OpenMap }} ctx
 * @returns {Record<string, ContractEntry>}
 */
function buildContract(walked, ctx) {
    /** @type {Map<string, ContractEntry>} */
    const byId = new Map();
    for (const route of walked) {
        const id = routeId(route);
        const entry = classify(route, ctx);
        const prev = byId.get(id);
        byId.set(id, prev ? weaker(prev, entry) : entry);
    }
    /** @type {Record<string, ContractEntry>} */
    const out = {};
    for (const id of [...byId.keys()].sort()) out[id] = byId.get(id) || { gate: 'unaccounted' };
    return out;
}

/**
 * Compare the recorded contract with what the router carries now.
 * @param {Record<string, ContractEntry>} recorded
 * @param {Record<string, ContractEntry>} observed
 */
function compareContract(recorded, observed) {
    /** @type {string[]} */
    const missing = [];      // in the router, not in the contract
    /** @type {string[]} */
    const stale = [];        // in the contract, no longer in the router
    /** @type {Array<{ id: string, recorded: ContractEntry, observed: ContractEntry }>} */
    const weakened = [];
    /** @type {string[]} */
    const unaccounted = [];
    /** @type {string[]} */
    const openWithoutReason = [];
    for (const id of Object.keys(observed)) {
        const now = observed[id];
        if (now.gate === 'unaccounted') unaccounted.push(id);
        if (now.gate === 'open' && now.via !== 'registry' && (now.reason || '').trim().length < 30) openWithoutReason.push(id);
        const was = recorded[id];
        if (!was) { missing.push(id); continue; }
        if (isWeaker(now, was)) weakened.push({ id, recorded: was, observed: now });
    }
    for (const id of Object.keys(recorded)) if (!observed[id]) stale.push(id);
    return { missing, stale, weakened, unaccounted, openWithoutReason };
}

/**
 * True when `now` lets more callers through than `was`.
 * @param {ContractEntry} now
 * @param {ContractEntry} was
 */
function isWeaker(now, was) {
    const rn = RANK[now.gate] ?? -1;
    const rw = RANK[was.gate] ?? -1;
    if (rn < rw) return true;
    if (rn > rw) return false;
    if (now.gate === 'permission' && was.gate === 'permission') {
        const allowed = new Set(was.anyOf || []);
        return (now.anyOf || []).some((p) => !allowed.has(p));
    }
    return false;
}

/** One line per difference, for an assertion message. */
function describeDiff(/** @type {ReturnType<typeof compareContract>} */ d) {
    const lines = [];
    for (const id of d.unaccounted) lines.push(`  ${id}: no gate anywhere (chain, handler, registry or auth/openRoutes.js)`);
    for (const id of d.openWithoutReason) lines.push(`  ${id}: open without a reason of at least 30 characters`);
    for (const w of d.weakened) lines.push(`  ${w.id}: recorded ${show(w.recorded)}, now ${show(w.observed)}`);
    for (const id of d.missing) lines.push(`  ${id}: not in auth/routes.contract.json`);
    for (const id of d.stale) lines.push(`  ${id}: in auth/routes.contract.json but no longer mounted`);
    return lines.join('\n');
}

/** @param {ContractEntry} e */
function show(e) {
    if (e.gate === 'permission') return `permission[${(e.anyOf || []).join(',')}]`;
    return e.via ? `${e.gate}(${e.via})` : e.gate;
}

module.exports = { RANK, IDENTITY_MW, routeId, chainClass, classify, buildContract, compareContract, isWeaker, describeDiff, show, weaker };
