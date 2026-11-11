// @typecheck strict
/**
 * App Studio: the font roles of an app's design (`design.fonts`, schema 3).
 *
 *   design.fonts = { heading?: <font>, body?: <font>, mono?: <font> }
 *
 * A <font> is the id of a family the Bee Flow server itself serves (FONT_ROLE_FAMILIES: the
 * files under agent-hub/public/fonts, declared by agent-hub marketing/self-hosted-fonts.css),
 * or `asset:<id>`, a WOFF2 the owner uploaded to the app's asset store (appAssets.mts). No
 * family here is fetched from another host: an app, its public page and its screenshot make no
 * font request outside Bee Flow. That is also why the list is not the CMS font list, which
 * names Google families.
 *
 * Every role is optional, and an absent role is today's rendering: body stays design.font (or
 * the host font), headings stay the body font, mono stays the system monospace stack. The page
 * side is agent-hub …/runtime/fonts/fontRoles.ts (pinned to this table by
 * fontRoles.lockstep.test.ts).
 *
 * The size of an uploaded font has an operator limit of its own, STUDIO_APP_FONT_MAX_BYTES
 * (default 4 MB, 0 = only the asset store's per-file limit).
 */

'use strict';

const { isAssetRef } = require('./componentSpecs/valueTypes');

/** The roles, in the order the stored object writes them. */
const FONT_ROLES = Object.freeze(/** @type {const} */ (['heading', 'body', 'mono']));

/**
 * The families a role can name, id → the folder of its files under agent-hub/public/fonts, the
 * CSS family name its @font-face rule declares, and its generic kind (the fallback stack on the
 * page: sans, serif or monospace).
 * @type {Readonly<Record<string, Readonly<{ dir: string, family: string, kind: 'sans' | 'serif' | 'mono' }>>>}
 */
const FONT_ROLE_FAMILIES = Object.freeze({
    inter: Object.freeze({ dir: 'inter', family: 'Inter', kind: 'sans' }),
    satoshi: Object.freeze({ dir: 'satoshi', family: 'Satoshi', kind: 'sans' }),
    'general-sans': Object.freeze({ dir: 'general-sans', family: 'General Sans', kind: 'sans' }),
    cabinet: Object.freeze({ dir: 'cabinet-grotesk', family: 'Cabinet Grotesk', kind: 'sans' }),
    'clash-display': Object.freeze({ dir: 'clash-display', family: 'Clash Display', kind: 'sans' }),
    'clash-grotesk': Object.freeze({ dir: 'clash-grotesk', family: 'Clash Grotesk', kind: 'sans' }),
    fraunces: Object.freeze({ dir: 'fraunces', family: 'Fraunces', kind: 'serif' }),
    'plex-mono': Object.freeze({ dir: 'ibm-plex-mono', family: 'IBM Plex Mono', kind: 'mono' }),
    'fira-code': Object.freeze({ dir: 'fira-code', family: 'Fira Code', kind: 'mono' }),
});

const DEFAULT_FONT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Is `value` something a role may hold: a family id of FONT_ROLE_FAMILIES or `asset:<id>`?
 * @param {unknown} value
 * @returns {value is string}
 */
function isFontValue(value) {
    if (isAssetRef(value)) return true;
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(FONT_ROLE_FAMILIES, value);
}

/**
 * The value to store for `design.fonts`, or undefined when nothing usable is left. Roles are
 * written in FONT_ROLES order; a role with an unknown family, and a key that is not a role, is
 * left out (fontRolesRepairNote says which).
 * @param {unknown} value
 * @returns {Partial<Record<'heading' | 'body' | 'mono', string>> | undefined}
 */
function cleanFontRoles(value) {
    if (!isObject(value)) return undefined;
    /** @type {Partial<Record<'heading' | 'body' | 'mono', string>>} */
    const out = {};
    for (const role of FONT_ROLES) {
        const v = value[role];
        if (isFontValue(v)) out[role] = v;
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * What saving took out of `design.fonts`, or null when nothing.
 * @param {unknown} value
 * @returns {string | null}
 */
function fontRolesRepairNote(value) {
    if (!isObject(value)) return `design.fonts must be an object { heading?, body?, mono? }. ${fontValueHint()}`;
    const dropped = [];
    for (const [key, v] of Object.entries(value)) {
        const isRole = /** @type {readonly string[]} */ (FONT_ROLES).includes(key);
        if (!isRole) dropped.push(`${key} (not a role: heading, body, mono)`);
        else if (v !== undefined && v !== null && !isFontValue(v)) dropped.push(`${key} ${JSON.stringify(v)}`);
    }
    return dropped.length ? `design.fonts: left out ${dropped.join(', ')}. ${fontValueHint()}` : null;
}

function fontValueHint() {
    return `A role takes one of ${Object.keys(FONT_ROLE_FAMILIES).join(', ')}, or asset:<id> of a WOFF2 font uploaded to this app.`;
}

/**
 * The most bytes one uploaded font may have: the env value, the default when unset or not a
 * whole number, Infinity for 0 (the asset store's own per-file limit still holds).
 * @param {Record<string, string | undefined>} [env]
 */
function fontMaxBytes(env = process.env) {
    const raw = String(env.STUDIO_APP_FONT_MAX_BYTES ?? '').trim();
    if (!raw) return DEFAULT_FONT_MAX_BYTES;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return DEFAULT_FONT_MAX_BYTES;
    return n === 0 ? Infinity : n;
}

/** The accepted form, for the AI catalogue and repair hints. */
const FONT_ROLES_SHAPE = `{ heading?, body?, mono? } each ${Object.keys(FONT_ROLE_FAMILIES).join('|')}|asset:<id>`;

const FONT_ROLES_TOOL_SCHEMA = Object.freeze({
    type: ['object', 'null'],
    properties: Object.freeze({
        heading: Object.freeze({ type: ['string', 'null'] }),
        body: Object.freeze({ type: ['string', 'null'] }),
        mono: Object.freeze({ type: ['string', 'null'] }),
    }),
});

const FONT_ROLES_DESCRIPTION = 'The typefaces of the app per role: headings, body text and code. '
    + `An object { heading?, body?, mono? }, every role optional; each is one of ${Object.keys(FONT_ROLE_FAMILIES).join(', ')} `
    + '(fraunces is a serif, plex-mono and fira-code are monospace, the rest sans-serif), or asset:<id> of a WOFF2 font uploaded to this app (app_list_assets). '
    + 'Every family is served by Bee Flow itself, so a font never makes a request to another host. '
    + 'body replaces design.font for all text; heading is drawn by every heading of the app and by a component whose style has font:"heading"; mono by code and by font:"mono". '
    + 'A role left out keeps the look it has today: body = design.font, heading = the body font, mono = the system monospace. '
    + 'Write it with app_set_theme { fonts: { heading: "fraunces", body: "inter" } } (the object replaces the one there), null removes it.';

module.exports = {
    FONT_ROLES,
    FONT_ROLE_FAMILIES,
    FONT_ROLES_SHAPE,
    FONT_ROLES_TOOL_SCHEMA,
    FONT_ROLES_DESCRIPTION,
    DEFAULT_FONT_MAX_BYTES,
    isFontValue,
    cleanFontRoles,
    fontRolesRepairNote,
    fontMaxBytes,
};
