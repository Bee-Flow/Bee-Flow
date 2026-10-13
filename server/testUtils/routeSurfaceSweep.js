// @typecheck
'use strict';

/**
 * Statische route-oppervlakte-sweep — de parser + pure sweep achter
 * auth/accessRegistry.sweep.test.js (de app-brede opvolger van de
 * /auth-drifttest).
 *
 * WAAROM STATISCH: de bestaande drifttest laadt de echte app in een
 * wegwerp-kindproces (auth/routeWalk.cli.js) — dat is en blijft het sterkste
 * bewijs, maar het dekt alleen de triagedPrefixes diepgaand en kost ~2 min per
 * run. Deze sweep leest index.js en elk bereikbaar routebestand als TEKST
 * (nooit een require van de app — dat start schedulers) en beantwoordt één
 * bredere vraag: is élke route verantwoord — aantoonbaar gegate op de mount,
 * op de router, op de route of in de handler, gedeclareerd in het registry,
 * of expliciet en met reden vrijgesteld in de sweep-test?
 *
 * WAT DIT BEWIJST: verantwoording, geen toereikendheid. Een probe-hit zegt
 * "deze handler kijkt naar wie de caller is", niet "de juiste caller". De
 * diepe verificatie is en blijft het werk van de drifttest (machinale
 * gate-tags) en de per-route authz-tests.
 *
 * PUUR MET OPZET: parseSurface leest bestanden uitsluitend via de meegegeven
 * readSource(relPath), en sweepSurface is een pure functie over het geparste
 * model + registry + vrijstellingen. Daardoor kan de test het hele mechanisme
 * met SYNTHETISCHE fixtures voeden en bewijzen dat een niet-geregistreerde
 * route écht rood oplevert — zonder canary-bestanden in de echte boom.
 */

const path = require('node:path');

// ── Gate-vocabulaire ─────────────────────────────────────────────────────────
// Identiteits-gates: middleware-namen die beslissen WIE er langs mag. Bewust
// NIET meegeteld:
//   • requireModule — verbergt een niet-geïmporteerde module; elke installatie
//     mét de module is open;
//   • requireCapability / requireFeature / requireLicenseFeature / requireTier /
//     requireBetaFeature en de *FeatureGate-kill-switches — entitlement-gates
//     laten een ANONIEME caller bewust door ("let auth middleware reject",
//     core/entitlements/entitlements.js requireCapability; license/middleware.js
//     header). Een mount met alléén zo'n gate is dus niet verantwoord: de echte
//     identiteitsgate moet in de router of handler zitten en telt daar mee;
//   • requireNcOrg (plumbing, zie accessRegistry.plumbingNames) en
//     requireActiveOrg* (raakt alleen mutaties).
const AUTH_GATE_RX = /\b_{0,2}(?:require(?!Module\b|NcOrg\b|ActiveOrg|Capability\b|Feature\b|License|Tier\b|Beta)[A-Z]\w*|attachOrgFilter|apiKeyAuth)\b/;
const MODULE_GATE_RX = /\brequireModule\s*\(/;

// Handler-probe — de tekstuele evenknie van routeWalk.cli.js:242-245, plus de
// vormen die dáár niet nodig waren omdat de walker alleen /auth diepgaand
// bekijkt: het zelf-401-patroon (if (!req.session…) return res.status(401))
// en token/HMAC-authenticatie (webhooks, bridge-tokens, MCP-bearer).
const PROBE_DIRECT = /\bisSuperAdmin\s*\(|\bhasPermission\s*\(|\bgetUserPermissions\s*\(|session\s*\??\.\s*isAdmin|\bresolveUserOrgIds\s*\(|\bperms\s*\.\s*includes\s*\(|\bisOrgAdmin|\bresolveEntitlements\s*\(|\bcanUseCapability\s*\(/;
// Ruimer dan de walker-variant (req op élke argumentpositie, en optioneel een
// module-privé underscore): canModifyAgent en canReadAgent krijgen req als
// derde argument, en supportInbox' routergate heet _hasSupportInbox(req).
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
 * Blankt commentaar uit (vervangen door spaties, zelfde lengte zodat offsets
 * blijven kloppen); strings en template-literals blijven staan. Regex-literals
 * worden herkend via de vorige betekenisvolle token, zodat een regex met //
 * of /* erin niet als commentaar wordt weggeblankt.
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
            // Regex of deling? Na een waarde (identifier, ), ], literal) is het
            // deling; na een operator/keyword is het een regex-literal.
            const isRegex = !/[\w)\]'"`]/.test(prevSignificant);
            if (isRegex) {
                // De body van een regex-literal wordt óók geblankt: haken erin
                // ([^\]] of \( ) zijn geen code, en de argument-balancer verderop
                // telt ze anders mee.
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

/** Ziet dit argument eruit als een router-referentie naar een lokaal bestand? */
function asRouterRef(argText, requires) {
    const inline = argText.match(INLINE_REQUIRE_RX);
    if (inline) {
        const prop = inline[2] || null;
        if (prop && !/router/i.test(prop)) return null; // require('./x').middleware
        return { spec: inline[1], prop };
    }
    if (/^\w+$/.test(argText) && requires.has(argText)) {
        const { spec, prop } = requires.get(argText);
        // Gedestructureerde gates (requireAuth as requireAuthedUser) zijn geen
        // routers; alleen een default-export of een expliciete .router-prop.
        if (prop && !/router/i.test(prop)) return null;
        if (AUTH_GATE_RX.test(argText) || MODULE_GATE_RX.test(argText)) return null;
        return { spec, prop };
    }
    return null;
}

/**
 * Eerste parameternaam per genoemde functie — de sleutel tot een gesplitste
 * router. Een groepsmodule (routes/webpages/crud.js, routes/playbooks/
 * recipeRoutes.js, routes/support/threads.js) roept zelf nooit express.Router()
 * aan; hij krijgt de router als ARGUMENT:
 *
 *     function register(router, deps) { router.get('/x', …); }
 *
 * Voor zo'n bestand is `router` dus de actieve router-variabele, en die naam
 * staat alleen in de parameterlijst. Dekt `function f(p)`, `const f = (p) =>`,
 * `const f = async (p) =>` en `const f = function (p)`.
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
 * Parseert één bestand tot registraties en submounts. Puur op tekst; het
 * resultaat wordt door parseSurface per mount-context omgezet in routes.
 */
function parseFile(src) {
    const clean = stripComments(src);
    const requires = parseRequires(clean);
    const routerVars = parseRouterVars(clean);
    const exported = exportedRouterVar(clean, routerVars);
    const fnParams = parseFnParams(clean);

    // Een groepsmodule van een gesplitste router roept zelf nooit
    // express.Router() aan — hij KRIJGT de router als eerste parameter. Zo'n
    // parameter telt hier als router-variabele zodra er ook echt routes op
    // worden geregistreerd; anders zou elke `function f(x)` er één zijn.
    // routerVars zelf blijft de zuivere express.Router()-verzameling: daar
    // hangen exportedRouterVar en de terugval in parseSurface aan.
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
                // Gate-vormige naam, of een inline functie die volgens de probe
                // naar de identiteit van de caller kijkt (zoals de 401-poort
                // die routes/license.js als anonieme router.use draagt).
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

    // ── Register-helpers: de over een map gesplitste router ──────────────────
    // Een router die over een map is gesplitst, hangt zijn groepen er niet met
    // router.use(...) aan, maar laat elke groep zichzelf registreren:
    //
    //     require('./crud').register(router, deps);   // routes/webpages/index.js
    //     mailbox.register(router);                   // routes/support.js
    //
    // Dat is een submount op '/' in alles behalve de schrijfwijze: dezelfde
    // router, hetzelfde padprefix, dezelfde keten-gates, dezelfde
    // registratievolgorde. Zonder deze tak verdwijnt élke route uit zo'n
    // groepsmodule geruisloos uit het oppervlak — precies het gevaar waar deze
    // sweep tegen is gebouwd: een poort die OPEN faalt. De router-variabele aan
    // de kindkant is de eerste parameter van de register-functie (parseFnParams).
    //
    // Twee bewuste beperkingen, zodat dit geen willekeurige functieaanroep gaat
    // opslokken:
    //   • de ontvanger moet een HELE lokale module zijn (require('./x') of een
    //     binding daarvan) — geen gedestructureerde naam, want die is een
    //     functie uit die module en niet de module zelf;
    //   • `app` telt hier NIET als router-argument. Pathloze app-helpers in het
    //     entry-bestand (boot/securityHeaders.applySecurityHeaders(app),
    //     boot/requestTiming.mountRequestTiming(app)) zijn plumbing — dezelfde
    //     klasse die gateApplies() hieronder ook al uitsluit.
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
 * Bouwt het route-oppervlak op vanaf een entry-bestand (index.js).
 *
 * @param {(relPath: string) => string|null} readSource bron per relatief pad
 * @param {string} entry  entry-bestand, bv. 'index.js'
 * @param {{ skipPrefix?: (p: string) => boolean }} [opts] mounts overslaan
 *        (bv. triagedPrefixes: die dekt de walker-drifttest al, dieper)
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

        // Binnengekomen via een register-helper? Dan is de actieve
        // router-variabele de eerste PARAMETER van die functie — een
        // groepsmodule roept zelf nooit express.Router() aan. Is die parameter
        // niet te vinden, dan vallen we terug op de gewone regel: liever
        // opaque (luid) dan stil niets.
        const viaParam = entryFn ? p.fnParams.get(entryFn) : null;
        const activeVars = viaParam ? new Set([viaParam]) : new Set(
            p.exported ? [p.exported] : [...p.routerVars, ...(file === entry ? ['app'] : [])],
        );
        if (file === entry) activeVars.add('app');

        // De actieve variabelen horen in de sleutel: één bestand kan via twee
        // register-functies worden binnengekomen (routes/support.js roept
        // threads.registerThreadRoutes én threads.registerBulkRoute aan). Delen
        // die dezelfde parameternaam, dan heeft de eerste doorloop het bestand
        // al volledig gelezen en is de tweede dubbel werk; verschillen ze, dan
        // moeten ze allebei.
        const key = `${file}::${prefix}::${[...activeVars].sort().join(',')}`;
        if (visited.has(key)) return;
        visited.add(key);

        let sawAnything = false;
        emitVar(file, p, activeVars, prefix, inherited, depth, () => { sawAnything = true; });
        if (!sawAnything) opaque.push({ file, prefix });
    }

    // App-level app.use(fn) zonder pad in het entry-bestand is PLUMBING (helmet,
    // sessies, body parsers, de bridge-middleware) — geen gate voor wat eronder
    // gemount wordt. Zelfde uitsluiting als routeWalk.cli.js maakt met isRoot.
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
 * Beslist per route of hij verantwoord is. Puur: geen IO, geen require van
 * app-code — alleen het geparste model, het registry en de vrijstellingen.
 *
 * Vrijstellings-sleutels (exempt: Map sleutel → reden):
 *   'METHOD /pad'        één route (zelfde sleutelvorm als het registry)
 *   'file:routes/x.js'   alle routes uit één bestand
 *   'mount:/prefix'      alles onder een mount (ook opaque/dynamische mounts)
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
        // Een gate geldt ongeacht de padvorm, dus ook een dynamische (regex-)
        // registratie is verantwoord zodra er evidence is; alleen een
        // dynamische route ZONDER gate vraagt een file:/mount:-vrijstelling.
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
