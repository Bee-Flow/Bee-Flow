// @typecheck
'use strict';
/**
 * WorkEvent: the one normalised record every pattern source emits and the
 * miner reads.
 *
 * Built from an explicit allow-list of fields. A source can hand makeEvent a
 * whole row; anything not listed below (a subject, a body, a sender, a file
 * path) is simply not copied. The template is masked once more on the way in,
 * so an address or a URL that slipped past a source's own templating still
 * never lands in an event.
 *
 * Pure: no I/O.
 */

const { maskText, templateIdOf } = require('./templating');

const SOURCES = Object.freeze(['ledger', 'meetings', 'documents', 'mail', 'files']);
const OBJECT_TYPES = Object.freeze(['tool', 'mail', 'file', 'document', 'meeting']);
const DIRECTIONS = Object.freeze(['in', 'out']);

const MAX_TEMPLATE_LEN = 160;
const ID_RE = /^[\p{L}\p{N}_.:-]{1,80}$/u;

/**
 * @typedef {{
 *   ts: number, source: string, app: string, verb: string, objectType: string,
 *   templateId: string|null, template: string|null, sessionKey: string|null,
 *   durationMs?: number, direction?: 'in'|'out', hasAttachment?: boolean,
 *   bulk?: boolean, domainPseudo?: string
 * }} WorkEvent
 */

/**
 * @param {any} input
 * @returns {WorkEvent|null} null when a required field is missing or invalid
 */
function makeEvent(input) {
    if (!input || typeof input !== 'object') return null;
    const ts = typeof input.ts === 'number' ? input.ts : Date.parse(input.ts);
    if (!Number.isFinite(ts) || ts <= 0) return null;
    if (!SOURCES.includes(input.source)) return null;
    if (!OBJECT_TYPES.includes(input.objectType)) return null;
    const app = typeof input.app === 'string' && ID_RE.test(input.app) ? input.app : null;
    const verb = typeof input.verb === 'string' && ID_RE.test(input.verb) ? input.verb : null;
    if (!app || !verb) return null;

    let template = null;
    if (typeof input.template === 'string' && input.template.trim()) {
        template = maskText(input.template).slice(0, MAX_TEMPLATE_LEN) || null;
    }
    let templateId = typeof input.templateId === 'string' && /^[0-9a-f]{12}$/.test(input.templateId)
        ? input.templateId : null;
    if (!templateId && template) templateId = templateIdOf(template);

    /** @type {WorkEvent} */
    const ev = {
        ts,
        source: input.source,
        app,
        verb,
        objectType: input.objectType,
        templateId,
        template,
        sessionKey: input.sessionKey == null ? null : String(input.sessionKey).slice(0, 120),
    };
    if (Number.isFinite(input.durationMs) && input.durationMs >= 0) ev.durationMs = Math.round(input.durationMs);
    if (DIRECTIONS.includes(input.direction)) ev.direction = input.direction;
    if (typeof input.hasAttachment === 'boolean') ev.hasAttachment = input.hasAttachment;
    if (typeof input.bulk === 'boolean') ev.bulk = input.bulk;
    if (typeof input.domainPseudo === 'string' && /^[\p{L}\p{N}_:-]{1,40}$/u.test(input.domainPseudo)) {
        ev.domainPseudo = input.domainPseudo;
    }
    return ev;
}

/**
 * Normalise a batch, dropping invalid rows.
 * @param {any[]} rows
 * @returns {WorkEvent[]}
 */
function makeEvents(rows) {
    const out = [];
    for (const r of rows || []) {
        const ev = makeEvent(r);
        if (ev) out.push(ev);
    }
    return out;
}

/**
 * Something the user did themselves (as opposed to something that arrived).
 * @param {WorkEvent} e
 */
function isUserAction(e) {
    if (e.source === 'ledger') return true;
    if (e.objectType === 'mail') return e.direction === 'out';
    if (e.objectType === 'file' || e.objectType === 'document') {
        return e.verb === 'file.created' || e.verb === 'file.changed' || e.verb === 'doc.uploaded';
    }
    return false;
}

module.exports = { SOURCES, OBJECT_TYPES, makeEvent, makeEvents, isUserAction };
