// @typecheck
'use strict';

/**
 * Static route-surface sweep — the parser + pure sweep behind auth/accessRegistry.sweep.test.js
 * (the app-wide successor of the /auth drift test).
 *
 * WHY STATIC: the existing drift test loads the real app in a throwaway child process
 * (auth/routeWalk.cli.js) — that is and remains the strongest proof, but it covers only the
 * triagedPrefixes in depth and costs ~2 min per run. This sweep reads index.js and every reachable
 * route file as TEXT (never a require of the app — that starts schedulers) and answers one broader
 * question: is EVERY route accounted for — demonstrably gated on the mount, on the router, on the
 * route or in the handler, declared in the registry, or explicitly and with a reason exempted in
 * the sweep test?
 *
 * WHAT THIS PROVES: accountability, not sufficiency. A probe hit says "this handler looks at who
 * the caller is", not "the right caller". The deep verification is and remains the work of the
 * drift test (machine-read gate tags) and the per-route authz tests.
 *
 * PURE ON PURPOSE: parseSurface reads files exclusively via the supplied readSource(relPath), and
 * sweepSurface is a pure function over the parsed model + registry + exemptions. That lets the test
 * feed the whole mechanism with SYNTHETIC fixtures and prove that an unregistered route really turns
 * red — without canary files in the real tree.
 */

const path = require('node:path');

// ── Gate vocabulary ─────────────────────────────────────────────────────────
// Identity gates: middleware names that decide WHO may pass. Deliberately NOT counted:
//   • requireModule — hides a module that is not imported; every installation WITH the module is open;
//   • requireCapability / requireFeature / requireLicenseFeature / requireTier / requireBetaFeature and
//     the *FeatureGate kill switches — entitlement gates deliberately let an ANONYMOUS caller through
//     ("let auth middleware reject", core/entitlements/entitlements.js requireCapability;
//     license/middleware.js header). A mount with only such a gate is therefore not accounted for: the
//     real identity gate must sit in the router or handler and counts there;
//   • requireNcOrg (plumbing, see accessRegistry.plumbingNames) and requireActiveOrg* (touches only
//     mutations).
const AUTH_GATE_RX = /\b_{0,2}(?:require(?!Module\b|NcOrg\b|ActiveOrg|Capability\b|Feature\b|License|Tier\b|Beta)[A-Z]\w*|attachOrgFilter|apiKeyAuth)\b/;
const MODULE_GATE_RX = /\brequireModule\s*\(/;

// Handler probe — the textual counterpart of routeWalk.cli.js:242-245, plus the shapes that were not
// needed there because the walker only examines /auth in depth: the self-401 pattern
// (if (!req.session…) return res.status(401)) and token/HMAC authentication (webhooks, bridge
// tokens, MCP bearer).
const PROBE_DIRECT = /\bisSuperAdmin\s*\(|\bhasPermission\s*\(|\bgetUserPermissions\s*\(|session\s*\??\.\s*isAdmin|\bresolveUserOrgIds\s*\(|\bperms\s*\.\s*includes\s*\(|\bisOrgAdmin|\bresolveEntitlements\s*\(|\bcanUseCapability\s*\(/;
// Broader than the walker variant (req in ANY argument position, and an optional module-private
// underscore): canModifyAgent and canReadAgent receive req as a third argument, and supportInbox'
// router gate is called _hasSupportInbox(req).
const PROBE_WRAPPER = /\b_{0,2}(?:is|has|can|assert|ensure|check|require|resolve|guard|verify|authenticate)[A-Z]\w*\s*\([^()]*\breq\b/;
const PROBE_TOKEN = /\btimingSafeEqual\s*\(|\bcreateHmac\s*\(|\bjwt\.verify\s*\(|\bverify\w*Signature\b|\bverify\w*Token\b/;
const PROBE_SELF_STATUS = /\bres\s*\.\s*status\s*\(\s*40[13]\b/;
const PROBE_SELF_SESSION = /\breq\s*\.\s*session\b/;

function probeText(text) {
    if (!text) return false;
    if (PROBE_DIRECT.test(text) || PROBE_WRAPPER.test(text) || PROBE_TOKEN.test(text)) return true;
    return PROBE_SELF_STATUS.test(text) && PROBE_SELF_SESSION.test(text);
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'all', 'options', 'head'];

// ── Bron-preparatie ──────────────────────────────────────────────────────────
/**
 * Blanks out comments (replaced by spaces, same length so that offsets stay correct); strings and
 * template literals remain. Regex literals are recognised via the previous meaningful token, so that
 * a regex containing // or /* is not blanked out as a comment.
 */
function stripComments(src) {
    const out = src.split('');
    let i = 0;
    let prevSignificant = '';
    const n = src.length;
    const blank = (from, to) => {
        for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
    };
    while (i < n) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            const start = i;
            while (i < n && src[i] !== '\n') i++;
            blank(start, i);
            continue;
        }
        if (c === '/' && next === '*') {
            const start = i;
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
            i = Math.min(n, i + 2);
            blank(start, i);
            continue;
        }
        if (c === '\'' || c === '"') {
            i++;
            while (i < n && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
            i++;
            prevSignificant = c;
            continue;
        }
        if (c === '`') {
            i++;
            while (i < n && src[i] !== '`') i += src[i] === '\\' ? 2 : 1;
            i++;
            prevSignificant = c;
            continue;
        }
        if (c === '/') {
            // Regex or division? After a value (identifier, ), ], literal) it is division; after an operator or
            // keyword it is a regex literal.
            const isRegex = !/[\w)\]'"`]/.test(prevSignificant);
            if (isRegex) {
                // The body of a regex literal is blanked too: brackets within it
                // ([^\]] or \( ) are not code, and the argument balancer further on would
                // otherwise count them.
                const start = i;
                i++;
                let inClass = false;
                while (i < n && (inClass || src[i] !== '/')) {
                    if (src[i] === '\\') i++;
                    else if (src[i] === '[') inClass = true;
                    else if (src[i] === ']') inClass = false;
                    i++;
                }
                blank(start + 1, Math.min(i, n));
                i++;
                prevSignificant = '/';
                continue;
            }
        }
        if (!/\s/.test(c)) prevSignificant = c;
        i++;
    }
    return out.join('');
}

/** Gebalanceerde argumentlijst vanaf de open-haak; geeft [tekst, eindindex]. */
function balancedArgs(src, openParen) {
    let depth = 0;
    let i = openParen;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < n && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
        } else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) return [src.slice(openParen + 1, i), i];
        }
        i++;
    }
    return [src.slice(openParen + 1), n];
}

/** Splitst argumenttekst op komma's op diepte 0 (buiten strings/haken). */
function splitTopLevel(argText) {
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < argText.length; i++) {
        const c = argText[i];
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < argText.length && argText[i] !== q) i += argText[i] === '\\' ? 2 : 1;
        } else if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) {
            parts.push(argText.slice(start, i).trim());
            start = i + 1;
        }
    }
    const last = argText.slice(start).trim();
    if (last) parts.push(last);
    return parts;
}

/** Gebalanceerd blok { … } vanaf de eerste { op of na `from`. */
function balancedBlock(src, from) {
    const open = src.indexOf('{', from);
    if (open === -1) return '';
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '\'' || c === '"' || c === '`') {
            const q = c;
            i++;
            while (i < src.length && src[i] !== q) i += src[i] === '\\' ? 2 : 1;
        } else if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) return src.slice(open, i + 1);
        }
    }
    return src.slice(open);
}

// ── Parser per bestand ───────────────────────────────────────────────────────
const STRING_LIT_RX = /^['"]([^'"]*)['"]$/;

function parseStringOrArray(argText) {
    const single = argText.match(STRING_LIT_RX);
    if (single) return [single[1]];
    if (argText.startsWith('[')) {
        const inner = argText.slice(1, argText.lastIndexOf(']'));
        const items = splitTopLevel(inner).map((s) => s.match(STRING_LIT_RX)).filter(Boolean).map((m) => m[1]);
        return items.length ? items : null;
    }
    return null;
}

/**
 * requires-kaart: lokale naam → { spec, prop }. Dekt
 *   const x = require('./a');  const { b } = require('./a');
 *   const { b: c } = require('./a');  const x = require('./a').y;
 */
function parseRequires(src) {
    const map = new Map();
    const rx = /(?:const|let|var)\s+(\w+|\{[^}]+\})\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)(?:\.(\w+))?/g;
    let m;
    while ((m = rx.exec(src))) {
        const [, binding, spec, tailProp] = m;
        if (binding.startsWith('{')) {
            for (const piece of binding.slice(1, -1).split(',')) {
                const [orig, renamed] = piece.split(':').map((s) => s.trim());
                if (!orig) continue;
                map.set(renamed || orig, { spec, prop: orig });
            }
        } else {
            map.set(binding, { spec, prop: tailProp || null });
        }
    }
    return map;
}

const INLINE_REQUIRE_RX = /^require\(\s*['"](\.[^'"]+)['"]\s*\)(?:\.(\w+))?$/;

/** Does this argument look like a router reference to a local file? */
function asRouterRef(argText, requires) {
    const inline = argText.match(INLINE_REQUIRE_RX);
    if (inline) {
        const prop = inline[2] || null;
        if (prop && !/router/i.test(prop)) return null; // require('./x').middleware
        return { spec: inline[1], prop };
    }
    if (/^\w+$/.test(argText) && requires.has(argText)) {
        const { spec, prop } = requires.get(argText);
        // Destructured gates (requireAuth as requireAuthedUser) are not routers; only a default export or
        // an explicit .router prop.
        if (prop && !/router/i.test(prop)) return null;
        if (AUTH_GATE_RX.test(argText) || MODULE_GATE_RX.test(argText)) return null;
        return { spec, prop };
    }
    return null;
}

/**
 * First parameter name per named function — the key to a split router. A group module
 * (routes/webpages/crud.js, routes/playbooks/recipeRoutes.js, routes/support/threads.js) never calls
 * express.Router() itself; it receives the router as an ARGUMENT:
 *
 *     function register(router, deps) { router.get('/x', …); }
 *
 * For such a file `router` is therefore the active router variable, and that name appears only in
 * the parameter list. Covers `function f(p)`, `const f = (p) =>`, `const f = async (p) =>` and
 * `const f = function (p)`.
 */
function parseFnParams(src) {
    const map = new Map();
    const rx = /(?:(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)\s*(?:=>|\{))/g;
    let m;
    while ((m = rx.exec(src))) {
        const name = m[1] || m[3];
        const params = m[2] !== undefined ? m[2] : m[4];
        if (!name || map.has(name)) continue;
        const first = splitTopLevel(params)[0];
        if (first && /^\w+$/.test(first)) map.set(name, first);
    }
    return map;
}

/** De router-variabelen (const x = express.Router() / Router()). */
function parseRouterVars(src) {
    const vars = new Set();
    const rx = /(?:const|let|var)\s+(\w+)\s*=\s*(?:require\(\s*['"]express['"]\s*\)\s*\.\s*|express\s*\.\s*)?Router\s*\(/g;
    let m;
    while ((m = rx.exec(src))) vars.add(m[1]);
    return vars;
}

/** Welke router-variabele exporteert dit bestand? */
function exportedRouterVar(src, routerVars) {
    let m = src.match(/module\.exports\s*=\s*(\w+)\s*;/);
    if (m && routerVars.has(m[1])) return m[1];
    m = src.match(/module\.exports\s*=\s*\{[^}]*\brouter\s*:?\s*(\w*)/);
    if (m) {
        const name = m[1] || 'router';
        if (routerVars.has(name)) return name;
    }
    m = src.match(/(?:module\.exports|exports)\.router\s*=\s*(\w+)/);
    if (m && routerVars.has(m[1])) return m[1];
    if (routerVars.size === 1) return [...routerVars][0];
    return null; // onbekend → alle routervars tellen mee (strikte superset)
}

/** Definitie van een genoemd handler-symbool in hetzelfde bestand, voor de probe. */
function namedFnText(src, name) {
    if (!/^\w+$/.test(name)) return null;
    let m = src.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
    if (m) return balancedBlock(src, m.index);
    m = src.match(new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>`));
    if (m) {
        const arrowEnd = src.indexOf('=>', m.index) + 2;
        const rest = src.slice(arrowEnd, arrowEnd + 20000);
        return rest.trimStart().startsWith('{') ? balancedBlock(src, arrowEnd) : rest.split('\n')[0];
    }
    return null;
}

/**
 * Parses one file into registrations and submounts. Purely on text; the result is converted by
 * parseSurface into routes per mount context.
 */
function parseFile(src) {
    const clean = stripComments(src);
    const requires = parseRequires(clean);
    const routerVars = parseRouterVars(clean);
    const exported = exportedRouterVar(clean, routerVars);
    const fnParams = parseFnParams(clean);

    // A group module of a split router never calls express.Router() itself — it RECEIVES the router as
    // its first parameter. Such a parameter counts here as a router variable as soon as routes are
    // actually registered on it; otherwise every `function f(x)` would be one. routerVars itself stays
    // the pure express.Router() collection: exportedRouterVar and the fallback in parseSurface hang on that.
    const recvVars = new Set(routerVars);
    for (const param of fnParams.values()) {
        if (recvVars.has(param)) continue;
        if (new RegExp(`\\b${param}\\s*\\.\\s*(?:${METHODS.join('|')}|use)\\s*\\(`).test(clean)) recvVars.add(param);
    }

    const registrations = []; // { routerVar, method, paths|null, offset, gate, moduleGate, probe }
    const routerGates = [];   // { routerVar, path, offset }
    const submounts = [];     // { routerVar, path, offset, ref | localVar, gate, moduleGate }

    const callRx = /\b(\w+)\s*\.\s*(get|post|put|patch|delete|all|options|head|use)\s*\(/g;
    let m;
    while ((m = callRx.exec(clean))) {
        const [, recv, method] = m;
        const isApp = recv === 'app';
        if (!recvVars.has(recv) && !isApp) continue;
        const [argText] = balancedArgs(clean, callRx.lastIndex - 1);
        const args = splitTopLevel(argText);
        if (!args.length) continue;

        const paths = parseStringOrArray(args[0]);
        const rest = paths ? args.slice(1) : args;
        const mountPath = paths ? paths[0] : '/';

        if (method === 'use') {
            let sawRouterRef = false;
            for (const arg of rest) {
                const ref = asRouterRef(arg, requires);
                if (ref) {
                    sawRouterRef = true;
                    submounts.push({
                        routerVar: recv, path: mountPath, offset: m.index, ref,
                        gate: rest.some((a) => a !== arg && AUTH_GATE_RX.test(a)),
                        moduleGate: rest.some((a) => a !== arg && MODULE_GATE_RX.test(a)),
                    });
                } else if (/^\w+$/.test(arg) && recvVars.has(arg)) {
                    sawRouterRef = true;
                    submounts.push({
                        routerVar: recv, path: mountPath, offset: m.index, localVar: arg,
                        gate: rest.some((a) => a !== arg && AUTH_GATE_RX.test(a)),
                        moduleGate: rest.some((a) => a !== arg && MODULE_GATE_RX.test(a)),
                    });
                }
            }
            if (!sawRouterRef) {
                // Gate-like name, or an inline function that, according to the probe, looks at the identity of the
                // caller (like the 401 gate that routes/license.js mounts as an anonymous router.use).
                const gated = rest.some((a) => AUTH_GATE_RX.test(a) || (/=>|function/.test(a) && probeText(a)));
                if (gated) routerGates.push({ routerVar: recv, path: paths ? mountPath : '/', offset: m.index });
            }
            continue;
        }

        // Route-registratie. Zonder letterlijk pad (dynamisch) → paths null.
        const middle = rest.slice(0, -1);
        const terminal = rest[rest.length - 1] || '';
        let probe = probeText(terminal);
        if (!probe && /^\w+$/.test(terminal)) probe = probeText(namedFnText(clean, terminal));
        registrations.push({
            routerVar: recv,
            method: method.toUpperCase(),
            paths,
            offset: m.index,
            gate: middle.some((a) => AUTH_GATE_RX.test(a)),
            moduleGate: middle.some((a) => MODULE_GATE_RX.test(a)),
            probe,
        });
    }

    // ── Register helpers: the router split across a folder ──────────────────
    // A router that is split across a folder does not attach its groups with router.use(...), but lets
    // each group register itself:
    //
    //     require('./crud').register(router, deps);   // routes/webpages/index.js
    //     mailbox.register(router);                   // routes/support.js
    //
    // That is a submount at '/' in everything but spelling: the same router, the same path prefix, the
    // same chain gates, the same registration order. Without this branch every route from such a group
    // module disappears from the surface silently — precisely the danger this sweep is built against: a
    // gate that fails OPEN. The router variable on the child side is the first parameter of the register
    // function (parseFnParams).
    //
    // Two deliberate limits, so that this does not swallow arbitrary function calls:
    //   • the receiver must be a WHOLE local module (require('./x') or a binding of it) — no destructured
    //     name, because that is a function from that module and not the module itself;
    //   • `app` does NOT count here as a router argument. Pathless app helpers in the entry file
    //     (boot/securityHeaders.applySecurityHeaders(app), boot/requestTiming.mountRequestTiming(app)) are
    //     plumbing — the same class that gateApplies() below already excludes.
    const helperRx = /(?:require\(\s*['"](\.[^'"]+)['"]\s*\)|\b(\w+))\s*\.\s*(\w+)\s*\(/g;
    while ((m = helperRx.exec(clean))) {
        const [, inlineSpec, localName, fn] = m;
        if (fn === 'use' || METHODS.includes(fn)) continue;
        let spec = inlineSpec || null;
        if (!spec && localName && requires.has(localName)) {
            const bound = requires.get(localName);
            if (!bound.prop) spec = bound.spec; // hele module, geen losse export
        }
        if (!spec) continue;
        const [argText] = balancedArgs(clean, helperRx.lastIndex - 1);
        const first = splitTopLevel(argText)[0];
        if (!first || !/^\w+$/.test(first) || !recvVars.has(first)) continue;
        submounts.push({
            routerVar: first, path: '/', offset: m.index,
            ref: { spec, prop: null }, registerFn: fn, gate: false, moduleGate: false,
        });
    }

    return { requires, routerVars, exported, registrations, routerGates, submounts, fnParams };
}

// ── Oppervlakte-opbouw (recursief over submounts) ────────────────────────────
const joinPrefix = (base, seg) => {
    if (!seg || seg === '/') return base || '';
    return `${base}${seg.startsWith('/') ? seg : `/${seg}`}`;
};

function resolveSpec(fromFile, spec, readSource) {
    const base = path.posix.join(path.posix.dirname(fromFile), spec);
    for (const candidate of [base, `${base}.js`, `${base}/index.js`]) {
        if (readSource(candidate) != null) return candidate;
    }
    return null;
}

/**
 * Builds the route surface starting from an entry file (index.js).
 *
 * @param {(relPath: string) => string|null} readSource source per relative path
 * @param {string} entry  entry file, e.g. 'index.js'
 * @param {{ skipPrefix?: (p: string) => boolean }} [opts] mounts to skip
 *        (e.g. triagedPrefixes: the walker drift test already covers those, in depth)
 * @returns {{ routes: Array, opaque: Array, files: string[], skippedMounts: string[] }}
 */
function parseSurface(readSource, entry, opts = {}) {
    const skipPrefix = opts.skipPrefix || (() => false);
    const parsed = new Map(); // file → parseFile-resultaat
    const routes = [];
    const opaque = []; // mounts naar bestanden zonder statisch leesbare routes
    const skippedMounts = [];
    const visited = new Set();

    const parseOf = (file) => {
        if (!parsed.has(file)) parsed.set(file, parseFile(readSource(file)));
        return parsed.get(file);
    };

    function emitFile(file, prefix, inherited, depth, entryFn = null) {
        if (depth > 12) return;
        const p = parseOf(file);

        // Entered via a register helper? Then the active router variable is the first PARAMETER of that
        // function — a group module never calls express.Router() itself. If that parameter cannot be found,
        // we fall back to the ordinary rule: better opaque (loud) than silently nothing.
        const viaParam = entryFn ? p.fnParams.get(entryFn) : null;
        const activeVars = viaParam ? new Set([viaParam]) : new Set(
            p.exported ? [p.exported] : [...p.routerVars, ...(file === entry ? ['app'] : [])],
        );
        if (file === entry) activeVars.add('app');

        // The active variables belong in the key: one file can be entered via two register functions
        // (routes/support.js calls threads.registerThreadRoutes AND threads.registerBulkRoute). If both share
        // the same parameter name, the first pass has already read the file completely and the second is
        // duplicate work; if they differ, both must be done.
        const key = `${file}::${prefix}::${[...activeVars].sort().join(',')}`;
        if (visited.has(key)) return;
        visited.add(key);

        let sawAnything = false;
        emitVar(file, p, activeVars, prefix, inherited, depth, () => { sawAnything = true; });
        if (!sawAnything) opaque.push({ file, prefix });
    }

    // App-level app.use(fn) without a path in the entry file is PLUMBING (helmet, sessions, body parsers,
    // the bridge middleware) — not a gate for what is mounted beneath it. The same exclusion as
    // routeWalk.cli.js makes with isRoot.
    const gateApplies = (isRoot) => (g) => !(isRoot && g.routerVar === 'app' && g.path === '/');

    function emitVar(file, p, vars, prefix, inherited, depth, sawCb) {
        const isRoot = file === entry;
        for (const reg of p.registrations) {
            if (!vars.has(reg.routerVar)) continue;
            sawCb();
            const localPaths = reg.paths || ['<dynamisch>'];
            for (const lp of localPaths) {
                const routerGated = p.routerGates.filter(gateApplies(isRoot)).some((g) =>
                    vars.has(g.routerVar) && g.routerVar === reg.routerVar && g.offset < reg.offset &&
                    (g.path === '/' || lp === g.path || lp.startsWith(`${g.path}/`)));
                routes.push({
                    method: reg.method,
                    path: reg.paths ? joinPrefix(prefix, lp) || '/' : `${prefix}/<dynamisch>`,
                    file,
                    dynamic: !reg.paths,
                    evidence: [
                        ...(inherited.gate ? ['mount'] : []),
                        ...(routerGated ? ['router'] : []),
                        ...(reg.gate ? ['route'] : []),
                        ...(reg.probe ? ['handler'] : []),
                    ],
                    moduleGated: inherited.moduleGate || reg.moduleGate,
                });
            }
        }

        for (const sub of p.submounts) {
            if (!vars.has(sub.routerVar)) continue;
            sawCb();
            const subPrefix = joinPrefix(prefix, sub.path);
            if (skipPrefix(subPrefix)) { skippedMounts.push(subPrefix); continue; }
            const parentGate = inherited.gate || sub.gate ||
                p.routerGates.filter(gateApplies(isRoot)).some((g) => vars.has(g.routerVar) && g.routerVar === sub.routerVar &&
                    g.offset < sub.offset && (g.path === '/' || sub.path === g.path || sub.path.startsWith(`${g.path}/`)));
            const nextInherited = { gate: parentGate, moduleGate: inherited.moduleGate || sub.moduleGate };
            if (sub.localVar) {
                emitVar(file, p, new Set([sub.localVar]), subPrefix, nextInherited, depth + 1, sawCb);
            } else {
                const resolved = resolveSpec(file, sub.ref.spec, readSource);
                if (resolved) emitFile(resolved, subPrefix, nextInherited, depth + 1, sub.registerFn || null);
                else opaque.push({ file, prefix: subPrefix, unresolved: sub.ref.spec });
            }
        }
    }

    emitFile(entry, '', { gate: false, moduleGate: false }, 0);
    return { routes, opaque, files: [...parsed.keys()], skippedMounts };
}

// ── De pure sweep ────────────────────────────────────────────────────────────
/**
 * Decides per route whether it is accounted for. Pure: no IO, no require of app code — only the
 * parsed model, the registry and the exemptions.
 *
 * Exemption keys (exempt: Map key → reason):
 *   'METHOD /path'        one route (same key form as the registry)
 *   'file:routes/x.js'    all routes from one file
 *   'mount:/prefix'       everything under a mount (also opaque/dynamic mounts)
 *
 * @returns {{ unaccounted, unaccountedOpaque, staleExempt, redundantExempt, stats }}
 */
function sweepSurface(surface, registry, exempt) {
    const triaged = (p) => (registry.triagedPrefixes || [])
        .some((pre) => p === pre || p.startsWith(`${pre}/`));
    const exemptUse = new Map([...exempt.keys()].map((k) => [k, { matched: 0, needed: 0 }]));

    const exemptKeyFor = (route) => {
        const id = `${route.method} ${route.path}`;
        if (exempt.has(id)) return id;
        const fileKey = `file:${route.file}`;
        if (exempt.has(fileKey)) return fileKey;
        for (const key of exempt.keys()) {
            if (!key.startsWith('mount:')) continue;
            const pre = key.slice(6);
            if (route.path === pre || route.path.startsWith(`${pre}/`)) return key;
        }
        return null;
    };

    const unaccounted = [];
    for (const route of surface.routes) {
        const id = `${route.method} ${route.path}`;
        if (triaged(route.path)) continue;
        // A gate applies regardless of the path form, so a dynamic (regex) registration is also accounted for
        // as soon as there is evidence; only a dynamic route WITHOUT a gate requires a file:/mount: exemption.
        const structural = route.evidence.length > 0;
        const declared = Boolean((registry.routes || {})[id]) || (registry.untriaged || []).includes(id);
        const key = exemptKeyFor(route);
        if (key) {
            const use = exemptUse.get(key);
            use.matched++;
            if (!structural && !declared) use.needed++;
            continue;
        }
        if (structural || declared) continue;
        unaccounted.push({ id, file: route.file, moduleGated: route.moduleGated, dynamic: route.dynamic });
    }

    const unaccountedOpaque = [];
    for (const o of surface.opaque) {
        if (triaged(o.prefix)) continue;
        const key = `mount:${o.prefix}`;
        if (exempt.has(key)) { exemptUse.get(key).matched++; exemptUse.get(key).needed++; continue; }
        const fileKey = `file:${o.file}`;
        if (exempt.has(fileKey)) { exemptUse.get(fileKey).matched++; exemptUse.get(fileKey).needed++; continue; }
        unaccountedOpaque.push(o);
    }

    const staleExempt = [...exemptUse.entries()].filter(([, u]) => u.matched === 0).map(([k]) => k);
    const redundantExempt = [...exemptUse.entries()]
        .filter(([, u]) => u.matched > 0 && u.needed === 0).map(([k]) => k);

    return {
        unaccounted,
        unaccountedOpaque,
        staleExempt,
        redundantExempt,
        stats: {
            routes: surface.routes.length,
            files: surface.files.length,
            opaque: surface.opaque.length,
            skippedMounts: surface.skippedMounts.length,
        },
    };
}

module.exports = {
    parseSurface,
    sweepSurface,
    parseFile,
    stripComments,
    probeText,
    AUTH_GATE_RX,
    MODULE_GATE_RX,
};
