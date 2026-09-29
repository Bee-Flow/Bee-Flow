/**
 * App Studio canonicalizer — the top level: the definition shell (meta, theme,
 * roles, design/nav/publicAccess/aiBrowsing) and the two passes over it.
 */

'use strict';

const {
    SCHEMA_VERSION_CURRENT,
    LIMITS,
    HEX_RE,
    THEME_SPEC,
} = require('../componentSpecs');
const { canonDesign, canonNavShape, resolveNavScreens } = require('../appDesignSpec');
const { migrateV1toV2 } = require('../migrate');
const { canonPublicAccess, resolvePublicScreens } = require('../publicAccess');
const { isObject, truncate } = require('./shared');
const { makeIdAllocator } = require('./ids');
const { canonScreen } = require('./screens');
const { canonAction } = require('./actions');
const { rewriteAndResolve } = require('./references');
const { cleanVariables } = require('./variables');

// ---------------------------------------------------------------------------
// Top level
// ---------------------------------------------------------------------------

function defaultTheme() {
    const theme = {};
    for (const [k, spec] of Object.entries(THEME_SPEC)) {
        if (spec.optional) continue; // emit-when-present (core/cms/themeSpec.js)
        theme[k] = spec.default;
    }
    return theme;
}

// def.roles (v2) — a key list only: [{ id, name }]. Definitions proper live in
// the data store; here we just keep well-shaped { id, name } entries so role
// references elsewhere can resolve. Absent/[] is normal (migrate seeds []).
function cleanRoles(raw, push) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) {
        push('roles.invalid', 'roles', 'roles must be an array of { id, name } — reset to [].');
        return [];
    }
    const out = [];
    const seen = new Set();
    raw.forEach((role, i) => {
        if (!isObject(role) || typeof role.id !== 'string' || !role.id) {
            push('role.invalid', `roles[${i}]`, 'Each role must be an object with a non-empty string id — dropped.');
            return;
        }
        if (seen.has(role.id)) {
            push('role.duplicate', `roles[${i}]`, `Duplicate role id ${JSON.stringify(role.id)} — dropped.`);
            return;
        }
        seen.add(role.id);
        const entry = { id: truncate(role.id, LIMITS.MAX_NAME_LEN, `roles[${i}].id`, push) };
        entry.name = typeof role.name === 'string' && role.name ? truncate(role.name, LIMITS.MAX_NAME_LEN, `roles[${i}].name`, push) : role.id;
        out.push(entry);
    });
    return out;
}

function canonicalizeAppDefinition(input) {
    const repairs = [];
    const push = (code, path, message) => repairs.push({ code, path, message });

    if (!isObject(input)) {
        push('shape.not_object', '', 'Definition must be an object — rebuilt as an empty shell; add screens before saving.');
        return {
            def: {
                schemaVersion: SCHEMA_VERSION_CURRENT,
                meta: { name: 'Untitled app', description: '', icon: 'LayoutGrid' },
                theme: defaultTheme(),
                homeScreenId: null,
                roles: [],
                screens: [],
                actions: {},
            },
            repairs,
        };
    }

    // Inline normalize step: upgrade v1 → v2 (lossless: schemaVersion=2, seed
    // roles). Migration itself is silent — only a genuinely invalid version tag
    // (present but neither 1 nor 2) is a repair worth surfacing.
    const rawSchemaVersion = input.schemaVersion;
    input = migrateV1toV2(input);

    const out = { schemaVersion: SCHEMA_VERSION_CURRENT };
    if (rawSchemaVersion !== undefined && rawSchemaVersion !== 1 && rawSchemaVersion !== SCHEMA_VERSION_CURRENT) {
        push('shape.schema_version', 'schemaVersion', `schemaVersion ${JSON.stringify(rawSchemaVersion)} normalized to ${SCHEMA_VERSION_CURRENT}.`);
    }

    // meta
    if (!isObject(input.meta)) {
        if (input.meta !== undefined) push('meta.invalid', 'meta', 'meta must be an object — rebuilt from defaults.');
        else push('meta.invalid', 'meta', 'meta missing — filled with defaults.');
        out.meta = { name: 'Untitled app', description: '', icon: 'LayoutGrid' };
    } else {
        const meta = {};
        if (typeof input.meta.name === 'string' && input.meta.name.trim()) {
            meta.name = truncate(input.meta.name, LIMITS.MAX_NAME_LEN, 'meta.name', push);
        } else {
            meta.name = 'Untitled app';
            push('meta.field_invalid', 'meta.name', 'meta.name must be a non-empty string — defaulted to "Untitled app".');
        }
        if (typeof input.meta.description === 'string') {
            meta.description = truncate(input.meta.description, LIMITS.MAX_STRING, 'meta.description', push);
        } else {
            meta.description = '';
            if (input.meta.description !== undefined && input.meta.description !== null) push('meta.field_invalid', 'meta.description', 'meta.description must be a string — reset to "".');
        }
        if (typeof input.meta.icon === 'string' && input.meta.icon) meta.icon = input.meta.icon;
        else {
            meta.icon = 'LayoutGrid';
            if (input.meta.icon !== undefined && input.meta.icon !== null) push('meta.field_invalid', 'meta.icon', 'meta.icon must be an icon name string — defaulted.');
        }
        out.meta = meta;
    }

    // theme
    if (!isObject(input.theme)) {
        if (input.theme !== undefined) push('theme.invalid', 'theme', 'theme must be an object — rebuilt from defaults.');
        out.theme = defaultTheme();
    } else {
        const theme = {};
        for (const [k, spec] of Object.entries(THEME_SPEC)) {
            const v = input.theme[k];
            const valid = spec.type === 'color'
                ? (typeof v === 'string' && HEX_RE.test(v))
                : spec.values.includes(v);
            if (valid) { theme[k] = v; continue; }
            if (spec.optional) {
                // Emit-when-present: unset — or null, the documented way to
                // clear one — stays absent. Only a WRONG value earns a repair.
                if (v !== undefined && v !== null) {
                    push('theme.value_invalid', `theme.${k}`, `theme.${k} ${JSON.stringify(v)} is invalid — dropped. Use #rrggbb, or null to clear it.`);
                }
                continue;
            }
            theme[k] = spec.default;
            if (v !== undefined) {
                push('theme.value_invalid', `theme.${k}`, `theme.${k} ${JSON.stringify(v)} is invalid — defaulted to ${JSON.stringify(spec.default)}.${spec.type === 'color' ? ' Use #rrggbb.' : ` Legal: ${spec.values.join(', ')}.`}`);
            }
        }
        out.theme = theme;
    }

    // roles (v2 — key references only; migrate seeds [] when absent)
    out.roles = cleanRoles(input.roles, push);

    // variables (v2.2 — EMIT-WHEN-PRESENT, like design/nav). An app that
    // declares none must round-trip to exactly the bytes it had before this
    // key existed, so an empty result omits the key entirely.
    const variables = cleanVariables(input.variables, push);
    if (variables.length) out.variables = variables;

    // screens (pass 1 — assigns every id, populating the rename map)
    const ids = makeIdAllocator(push);
    out.screens = [];
    let rawScreens = input.screens;
    if (!Array.isArray(rawScreens)) {
        push('screens.invalid', 'screens', 'screens must be an array — reset to []. The validator requires at least one screen.');
        rawScreens = [];
    }
    rawScreens.forEach((screen, i) => {
        if (!isObject(screen)) {
            push('screen.invalid', `screens[${i}]`, 'Screen is not an object — dropped.');
            return;
        }
        out.screens.push(canonScreen(screen, `screens[${i}]`, ids, push));
    });

    // actions
    out.actions = {};
    let rawActions = input.actions;
    if (rawActions !== undefined && !isObject(rawActions)) {
        push('actions.invalid', 'actions', 'actions must be an object map of { actionId: action } — reset to {}.');
        rawActions = undefined;
    }
    for (const [key, action] of Object.entries(rawActions || {})) {
        const path = `actions.${key}`;
        if (!isObject(action)) {
            push('action.invalid', path, 'Action is not an object — dropped.');
            continue;
        }
        const id = ids.canonId(key, 'action', path);
        out.actions[id] = canonAction(action, `actions.${id}`, push);
    }

    // design / nav (App Design v2) — EMIT-WHEN-PRESENT: an absent key stays
    // absent, so every pre-v2 definition canonicalizes byte-identically and
    // the templates' "no structural repairs" contract is untouched. Present
    // objects canonicalize to their complete deterministic form (theme
    // precedent). Nav group screen refs resolve in pass 2 below, where the
    // rename map and the final screen-id set exist.
    if (isObject(input.design)) {
        out.design = canonDesign(input.design, push);
    } else if (input.design !== undefined) {
        push('design.invalid', 'design', 'design must be an object — dropped.');
    }
    if (isObject(input.nav)) {
        out.nav = canonNavShape(input.nav, push);
    } else if (input.nav !== undefined) {
        push('nav.invalid', 'nav', 'nav must be an object — dropped.');
    }

    // publicAccess — shape now, screen-id resolution in pass 2 (see below).
    const publicAccess = canonPublicAccess(input.publicAccess, push);

    // aiBrowsing — EMIT-WHEN-PRESENT. { enabled: boolean, allowedDomains?:
    // lowercased bare hostnames }. HUMAN-set (App settings): the builder tools
    // deliberately cannot write this key, so the canonicalizer only ever sees
    // it from the product UI or a hand-authored definition.
    if (isObject(input.aiBrowsing)) {
        const src = input.aiBrowsing;
        const ab = { enabled: src.enabled === true };
        if (Array.isArray(src.allowedDomains)) {
            const domains = src.allowedDomains
                .map((d) => String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[/:].*$/, ''))
                .filter(Boolean)
                .slice(0, 100)
                .map((d) => d.slice(0, 253));
            if (domains.length) ab.allowedDomains = [...new Set(domains)];
        }
        out.aiBrowsing = ab;
    } else if (input.aiBrowsing !== undefined) {
        push('aiBrowsing.invalid', 'aiBrowsing', 'aiBrowsing must be an object { enabled, allowedDomains? } — dropped.');
    }

    // carry homeScreenId across for pass 2 (resolution happens there)
    out.homeScreenId = typeof input.homeScreenId === 'string' ? input.homeScreenId : input.homeScreenId === null ? null : undefined;

    // pass 2 — rewrite renamed references, strip dangling events, fix home
    rewriteAndResolve(out, ids.renameMap, push);

    if (out.nav) {
        const validScreenIds = new Set(out.screens.map((s) => s.id));
        const resolved = resolveNavScreens(out.nav, ids.renameMap, validScreenIds, push);
        if (resolved) out.nav = resolved;
        else delete out.nav;
    }

    // publicAccess (EMIT-WHEN-PRESENT, like design/nav/variables). Its screen
    // ids resolve here for the same reason nav's do: pass 1 is where ids are
    // allocated, so the rename map is only complete now.
    if (publicAccess) {
        const validScreenIds = new Set(out.screens.map((s) => s.id));
        const resolved = resolvePublicScreens(publicAccess, ids.renameMap, validScreenIds, push);
        if (resolved) out.publicAccess = resolved;
    }

    return { def: out, repairs };
}

module.exports = { canonicalizeAppDefinition };
