/**
 * App Studio — PUBLIC SURFACE resolution.
 *
 * One app, two audiences. A Studio app is otherwise entirely behind
 * `requireAuth`: every route in studioApps / studioAppsRun / studioAppData /
 * studioAppFiles resolves a session user, and publishing shares with org groups
 * — never with the open internet. `publicAccess` carves out a NAMED, BOUNDED
 * part of one app that an anonymous visitor may open, so an intake form and the
 * back-office that processes it can live in the SAME app instead of being split
 * across an app and a hosted automation form.
 *
 * The definition block (canonicalized in canonicalize.js, emit-when-present):
 *
 *   publicAccess: {
 *     entryScreenId: 'scr_x',        // where an anonymous visitor lands
 *     screenIds: ['scr_x', 'scr_y'], // every screen they may reach (incl. entry)
 *     title?: 'Aanvraag meterkast',  // browser title; meta.name otherwise
 *     theme?: { canvas: '#ffda00', accent: '#009b3e' },  // the page's OWN look,
 *     design?: { font: 'poppins' },                       // merged over the app's
 *   }
 *
 * ── WHY THE PUBLIC PAGE MAY CARRY ITS OWN LOOK ──────────────────────
 * One app, two audiences — and two brands. The form a customer fills in is
 * the customer's: it wears their colours and their typeface. The back office
 * behind it is the owner's tool and keeps the owner's look. Both `theme` and
 * `design` are PARTIAL (name only what differs) and are merged over the app's
 * when the page is served (buildPublicDefinition), so nothing about the app's
 * own screens changes when a public page is restyled.
 *
 * There is no role to configure: an anonymous visitor always carries the
 * reserved role `public`.
 *
 * ── WHAT "PUBLIC" MEANS HERE ────────────────────────────────────────
 * It is a whitelist, never a role gate. Three independent things are derived
 * from `screenIds` and nothing else:
 *
 *   1. SCREENS   — only the listed screens are sent to the browser. Every other
 *                  screen, and the whole `nav` tree that names them, is dropped
 *                  before the definition leaves the process. An anonymous
 *                  visitor cannot learn that the back-office screens exist.
 *   2. ACTIONS   — only actions WIRED to a component on those screens may run
 *                  (collectReferencedActions, the same reachability walk the
 *                  validator uses). An action id posted by hand resolves to
 *                  nothing.
 *   3. TABLES    — nothing here. Table access is the RLS gateway's job: the
 *                  visitor carries the RESERVED role `public`, and the gateway
 *                  denies that role by default instead of falling back to the
 *                  table's access.default (see dataModel.PUBLIC_ROLE_KEY — an
 *                  ordinary table defaults to 'app', which would have handed
 *                  every visitor every row). A table must grant `public`
 *                  explicitly, per action. This module never widens data access.
 *
 * ── WHY SERVER STEP BODIES ARE REDACTED ─────────────────────────────
 * The client coordinator (runtime/useActionRunner.js) walks the action sequence
 * itself and posts a step INDEX; the server re-resolves the step from its own
 * copy of the definition and never trusts a client-supplied body. So the browser
 * needs a server step's `kind` (is this mine to run or the server's?) and its
 * `resultVar` (where to store what comes back) — and nothing else. Prompts,
 * table ids, recipient addresses and file templates are stripped. The pre-order
 * index is preserved exactly, because only client steps (condition/loop/switch)
 * have children and those are kept whole.
 */

'use strict';

const { collectReferencedActions } = require('./validate');
const { DATA_MUTATING_STEP_KINDS } = require('./componentSpecs');
const { THEME_SPEC, HEX_RE, canonicalizeTheme } = require('../core/cms/themeSpec');
const { DESIGN_SPEC } = require('./appDesignSpec');
// The reserved anonymous role. It lives in dataModel because the RLS gateway —
// which must recognise it by name to deny by default — already reads that
// module, and a constant defined here would make the gateway depend on the
// public surface rather than on its own vocabulary.
const { PUBLIC_ROLE_KEY } = require('./dataModel');

/** Viewer ids minted for anonymous visitors are prefixed so they can never
 *  collide with a real user id (and are obvious in a created_by column). */
const ANON_VIEWER_PREFIX = 'anon:';

/** A public page may expose at most this many screens — a wizard, not an app. */
const MAX_PUBLIC_SCREENS = 12;

function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isThemeValue(spec, v) {
    return spec.type === 'color'
        ? (typeof v === 'string' && HEX_RE.test(v))
        : spec.values.includes(v);
}

function isDesignValue(spec, v) {
    if (spec.type === 'enum') return spec.values.includes(v);
    if (spec.type === 'url') return typeof v === 'string' && /^https:\/\//.test(v) && v.length <= spec.maxLen;
    return false;
}

/**
 * A PARTIAL look override (publicAccess.theme / publicAccess.design): valid
 * knobs are kept, everything else is dropped with a repair. A knob set to
 * null means "no override for this one" and is simply absent. Returns null
 * when nothing survives, so the key stays out of the canonical form.
 */
function canonLookOverride(raw, SPEC, path, push, isValid, skip = []) {
    if (raw === undefined || raw === null) return null;
    if (!isObject(raw)) {
        push(`${path}.invalid`, path, `${path} must be an object of knobs — dropped.`);
        return null;
    }
    const legal = Object.keys(SPEC).filter((k) => !skip.includes(k));
    const out = {};
    for (const [key, v] of Object.entries(raw)) {
        const spec = SPEC[key];
        if (!spec || skip.includes(key)) {
            push(`${path}.unknown_key`, `${path}.${key}`, `Unknown key "${key}" — dropped. Legal: ${legal.join(', ')}.`);
            continue;
        }
        if (v === null || v === undefined) continue;
        if (!isValid(spec, v)) {
            push(`${path}.value_invalid`, `${path}.${key}`, `${path}.${key} ${JSON.stringify(v)} is invalid — dropped.${spec.type === 'color' ? ' Use #rrggbb.' : (spec.values ? ` Legal: ${spec.values.join(', ')}.` : '')}`);
            continue;
        }
        out[key] = v;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * Shape-canonicalize a `publicAccess` block. Screen ids are NOT resolved here —
 * canonicalize.js runs this in pass 1 (before the id-rename map is complete)
 * and calls resolvePublicScreens() in pass 2, exactly as it does for
 * homeScreenId and the nav tree.
 *
 * Returns null when the block is absent or unusable, so the key stays absent
 * and an app that never opted in canonicalizes byte-identically to before this
 * feature existed.
 */
function canonPublicAccess(input, push) {
    if (input === undefined || input === null) return null;
    if (!isObject(input)) {
        push('publicAccess.invalid', 'publicAccess', 'publicAccess must be an object { entryScreenId, screenIds, roleKey } — dropped.');
        return null;
    }

    const out = {};

    const entry = typeof input.entryScreenId === 'string' ? input.entryScreenId.trim() : '';
    if (!entry) {
        push('publicAccess.no_entry', 'publicAccess.entryScreenId', 'publicAccess needs an entryScreenId — the screen an anonymous visitor lands on. Block dropped.');
        return null;
    }
    out.entryScreenId = entry;

    const raw = Array.isArray(input.screenIds) ? input.screenIds : [];
    const ids = [];
    for (const id of raw) {
        if (typeof id !== 'string' || !id.trim()) continue;
        const trimmed = id.trim();
        if (!ids.includes(trimmed)) ids.push(trimmed);
    }
    // The entry screen is public by definition — listing it is optional.
    if (!ids.includes(entry)) ids.unshift(entry);
    if (ids.length > MAX_PUBLIC_SCREENS) {
        push('publicAccess.too_many_screens', 'publicAccess.screenIds', `A public page may expose at most ${MAX_PUBLIC_SCREENS} screens — the rest were dropped.`);
        ids.length = MAX_PUBLIC_SCREENS;
    }
    out.screenIds = ids;

    // The anonymous role is RESERVED, not configurable. The RLS gateway
    // recognises it by name to deny by default (see dataModel.PUBLIC_ROLE_KEY);
    // a per-app key would mean the gateway could not tell an anonymous role
    // from an ordinary one, and an ordinary one inherits access.default.
    const role = typeof input.roleKey === 'string' ? input.roleKey.trim() : '';
    if (role && role !== PUBLIC_ROLE_KEY) {
        push('publicAccess.role_reserved', 'publicAccess.roleKey', `Anonymous visitors always carry the reserved role "${PUBLIC_ROLE_KEY}" — roleKey ${JSON.stringify(role)} was ignored.`);
    }
    out.roleKey = PUBLIC_ROLE_KEY;

    if (typeof input.title === 'string' && input.title.trim()) {
        out.title = input.title.trim().slice(0, 200);
    }

    // The page's own look — see the docblock. `preset` is provenance for the
    // editor's gallery, not a knob, so it cannot be overridden here.
    const theme = canonLookOverride(input.theme, THEME_SPEC, 'publicAccess.theme', push, isThemeValue);
    if (theme) out.theme = theme;
    const design = canonLookOverride(input.design, DESIGN_SPEC, 'publicAccess.design', push, isDesignValue, ['preset']);
    if (design) out.design = design;

    return out;
}

/**
 * Pass-2 resolution: drop screen ids that no longer exist (or were renamed by
 * the id allocator) and drop the whole block when the entry screen is gone.
 * Mirrors how homeScreenId and nav groups are resolved.
 *
 * @param {object|null} pa       canonPublicAccess output
 * @param {Map<string,string>} renames  old id → canonical id
 * @param {Set<string>} screenIds       the definition's final screen ids
 */
function resolvePublicScreens(pa, renames, screenIds, push) {
    if (!pa) return null;
    const remap = (id) => (renames && renames.has(id) ? renames.get(id) : id);

    const entry = remap(pa.entryScreenId);
    if (!screenIds.has(entry)) {
        push('publicAccess.entry_unresolved', 'publicAccess.entryScreenId', `publicAccess.entryScreenId ${JSON.stringify(pa.entryScreenId)} does not resolve to a screen — public access dropped.`);
        return null;
    }

    const ids = [];
    for (const id of pa.screenIds) {
        const resolved = remap(id);
        if (!screenIds.has(resolved)) {
            push('publicAccess.screen_unresolved', 'publicAccess.screenIds', `publicAccess.screenIds ${JSON.stringify(id)} does not resolve to a screen — dropped.`);
            continue;
        }
        if (!ids.includes(resolved)) ids.push(resolved);
    }
    if (!ids.includes(entry)) ids.unshift(entry);

    return { ...pa, entryScreenId: entry, screenIds: ids };
}

/**
 * The public surface of a definition: which screens an anonymous visitor sees
 * and which actions they may run.
 *
 * @returns {{ok:boolean, reason?:string, entryScreenId?:string,
 *            screenIds?:Set<string>, screens?:object[], actionIds?:Set<string>,
 *            roleKey?:string, title?:string}}
 */
function resolvePublicSurface(definition) {
    if (!isObject(definition)) return { ok: false, reason: 'no_definition' };
    const pa = definition.publicAccess;
    if (!isObject(pa)) return { ok: false, reason: 'not_public' };

    const allScreens = Array.isArray(definition.screens) ? definition.screens : [];
    const wanted = new Set(Array.isArray(pa.screenIds) ? pa.screenIds : []);
    const screens = allScreens.filter((s) => isObject(s) && wanted.has(s.id));
    if (!screens.length) return { ok: false, reason: 'no_screens' };
    if (!screens.some((s) => s.id === pa.entryScreenId)) return { ok: false, reason: 'no_entry_screen' };

    return {
        ok: true,
        entryScreenId: pa.entryScreenId,
        screenIds: new Set(screens.map((s) => s.id)),
        screens,
        // Reachability is computed from the PUBLIC screens only — an action
        // wired exclusively on a back-office screen is not runnable here.
        actionIds: collectReferencedActions(screens),
        roleKey: pa.roleKey || PUBLIC_ROLE_KEY,
        ...(pa.title ? { title: pa.title } : {}),
    };
}

/** A server step, reduced to what the browser coordinator actually reads. */
function redactStep(step) {
    if (!isObject(step)) return step;
    if (DATA_MUTATING_STEP_KINDS.includes(step.kind)) {
        return step.resultVar ? { kind: step.kind, resultVar: step.resultVar } : { kind: step.kind };
    }
    // Client steps run in the browser, so they travel whole — but their nested
    // branches carry server steps of their own.
    const out = { ...step };
    if (Array.isArray(step.then)) out.then = step.then.map(redactStep);
    if (Array.isArray(step.else)) out.else = step.else.map(redactStep);
    if (Array.isArray(step.steps)) out.steps = step.steps.map(redactStep);
    if (Array.isArray(step.cases)) {
        out.cases = step.cases.map((c) => (isObject(c) && Array.isArray(c.steps) ? { ...c, steps: c.steps.map(redactStep) } : c));
    }
    if (Array.isArray(step.default)) out.default = step.default.map(redactStep);
    return out;
}

/** Redact one action for anonymous delivery, preserving step indices exactly. */
function redactAction(action) {
    if (!isObject(action)) return action;
    if (action.kind === 'sequence') {
        return { ...action, steps: (Array.isArray(action.steps) ? action.steps : []).map(redactStep) };
    }
    // A bare v1 action IS its own single step.
    return redactStep(action);
}

/**
 * The definition an anonymous visitor's browser receives: the public screens,
 * the actions those screens wire (bodies redacted), and the look. Everything
 * else — other screens, the nav tree that names them, connectors, the app's
 * other actions — never leaves the process.
 */
function buildPublicDefinition(definition, surface) {
    const pa = isObject(definition.publicAccess) ? definition.publicAccess : {};
    const out = {
        schemaVersion: definition.schemaVersion,
        meta: {
            name: surface.title || definition.meta?.name || 'Formulier',
            description: '',
            icon: definition.meta?.icon || 'LayoutGrid',
        },
        // The page's own look over the app's. Without an override the app
        // theme travels UNTOUCHED (not re-canonicalized): a public page must
        // render exactly what the owner's own run of that screen renders.
        theme: isObject(pa.theme)
            ? canonicalizeTheme({ ...(isObject(definition.theme) ? definition.theme : {}), ...pa.theme })
            : definition.theme,
        homeScreenId: surface.entryScreenId,
        roles: [],
        screens: surface.screens,
        actions: {},
    };
    const design = isObject(pa.design)
        ? { ...(isObject(definition.design) ? definition.design : {}), ...pa.design }
        : definition.design;
    if (isObject(design)) out.design = design;
    if (Array.isArray(definition.variables) && definition.variables.length) out.variables = definition.variables;

    const actions = isObject(definition.actions) ? definition.actions : {};
    for (const id of surface.actionIds) {
        if (Object.hasOwn(actions, id)) out.actions[id] = redactAction(actions[id]);
    }
    // Deliberately absent: `nav`. Its groups name back-office screens, so
    // shipping it would leak the app's internal structure to the open internet.
    return out;
}

module.exports = {
    PUBLIC_ROLE_KEY,
    ANON_VIEWER_PREFIX,
    MAX_PUBLIC_SCREENS,
    canonPublicAccess,
    resolvePublicScreens,
    resolvePublicSurface,
    buildPublicDefinition,
    // Test-only internals
    _redactStep: redactStep,
    _redactAction: redactAction,
};
