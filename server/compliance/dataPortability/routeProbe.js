/**
 * Route probe — "would a request for METHOD path reach a handler?"
 *
 * Walks an Express 5 router stack the way the router itself dispatches: every
 * layer's matcher is tried against the path, a matching route layer answers
 * for its methods, a matching mount layer (sub-router or sub-app) strips the
 * matched prefix and recurses. `:params` in the pattern are filled with
 * placeholder segments before matching, so `/api/automation/:id/export` probes
 * as `/api/automation/probe-id/export`.
 *
 * The matchers are called directly (`layer.matchers[i](path)`), NOT
 * `layer.match(path)`: the latter writes `layer.params`/`layer.path` on the
 * live router objects, and a probe must leave the running server untouched.
 * Express 4 layers (`layer.regexp`) are handled for completeness.
 *
 * Used by the Data Act export registry to verify that every DECLARED export
 * route is actually mounted — a declaration in a table proves nothing on its
 * own, and a route that moves would otherwise keep passing the check.
 */

'use strict';

const MAX_DEPTH = 16;

/** The layer stack behind an app, a Router, or nothing. */
function stackOf(target) {
    if (!target || (typeof target !== 'function' && typeof target !== 'object')) return null;
    try {
        if (Array.isArray(target.stack)) return target.stack;                 // express.Router()
        const r = target.router || target._router;                             // express() app (5.x getter / 4.x)
        if (r && Array.isArray(r.stack)) return r.stack;
    } catch { /* a getter that throws is not a router */ }
    return null;
}

/** Turn a route pattern into one concrete path: `:id` → `probe-id`, `*` → `probe-wild`. */
function samplePath(pattern) {
    let p = String(pattern || '/').split('?')[0];
    p = p.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?[?*+]?/g, (_m, name) => `probe-${name}`);
    p = p.replace(/\{[^}]*\}/g, '');          // optional groups (path-to-regexp v8) — probe the short form
    p = p.replace(/\*+[A-Za-z0-9_]*/g, 'probe-wild');
    if (!p.startsWith('/')) p = `/${p}`;
    return p;
}

/** Non-mutating layer match → `{ path }` (the matched prefix) or null. */
function matchLayer(layer, path) {
    if (!layer) return null;
    if (layer.slash) return { path: '' };                                     // `use('/')` fast path
    if (Array.isArray(layer.matchers)) {
        for (const matcher of layer.matchers) {
            try {
                const r = matcher(path);
                if (r) return { path: r.path || '' };
            } catch { /* undecodable segment — not a match */ }
        }
        return null;
    }
    if (layer.regexp instanceof RegExp) {                                     // express 4
        const m = layer.regexp.exec(path);
        return m ? { path: m[0] } : null;
    }
    return null;
}

function routeHandles(route, method) {
    const methods = route?.methods || {};
    if (methods._all) return true;
    const m = String(method).toLowerCase();
    if (methods[m]) return true;
    return m === 'head' && !!methods.get;
}

function walk(stack, path, method, depth) {
    if (!Array.isArray(stack) || depth > MAX_DEPTH) return false;
    for (const layer of stack) {
        const m = matchLayer(layer, path);
        if (!m) continue;
        if (layer.route) {
            if (routeHandles(layer.route, method)) return true;
            continue;
        }
        const sub = stackOf(layer.handle);
        if (!sub) continue;
        let rest = path.slice((m.path || '').length);
        if (!rest.startsWith('/')) rest = `/${rest}`;                         // mirrors the router's slashAdded
        if (walk(sub, rest, method, depth + 1)) return true;
    }
    return false;
}

/**
 * @param {object|Function} target an express() app or an express.Router()
 * @param {string} method HTTP method ('GET', 'post', …)
 * @param {string} pathPattern route path as served, params allowed ('/api/x/:id/export')
 * @returns {boolean}
 */
function isMounted(target, method, pathPattern) {
    const stack = stackOf(target);
    if (!stack) return false;
    return walk(stack, samplePath(pathPattern), method || 'GET', 0);
}

module.exports = { isMounted, samplePath, _stackOf: stackOf, _matchLayer: matchLayer };
