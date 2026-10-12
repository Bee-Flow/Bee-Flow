// @typecheck
'use strict';

/**
 * Chat signals: what the clients are told. Pure, no I/O.
 *
 * The resolver (core/entitlements/chatMonitoringFlag.resolveChatMonitoring)
 * decides; this module turns its answer into the three payloads that carry it
 * to a chat, each built from an explicit allow-list so nothing else can ride
 * along:
 *
 *   statusPayload(mon)    /api/privacy/shield-status → `chatMonitoring`
 *                         { state, from, version, surfaces, signals, noticeUrl }
 *   embedNotice(mon)      GET /agents/:id/embed → `complianceNotice` (a public body)
 *                         { state, from, version, signals, privacyNoticeUrl }
 *   agentCounting(mon, { callerOrgId, agentOrgId })
 *                         GET /agents/:id → `complianceCounting` { state, from }
 *
 * A client builds its notice marker (`<surface>@<version>`) from these and the
 * recorder (core/privacy/chatSignals.js) counts a turn only when that marker
 * matches the resolver's current version: what is announced here is exactly
 * what is counted. Paused surfaces are never listed (the resolver keeps them
 * out of `surfaces`), and a state that cannot be tied to a version reads as
 * off: without a version there is no marker, and a notice without a marker
 * would announce something that is then not counted.
 *
 * What never appears: ids, names, an org name, counts or error text. Only
 * enums, a date, the version timestamp, and https links the organisation
 * itself published under Art. 13.
 */

const V = require('../../stores/lib/chatMonitoringVocab');

/** @typedef {'off'|'scheduled'|'on'} MonitoringState */
/**
 * @typedef {{ state: MonitoringState, from: string|null, version: string|null,
 *   surfaces: readonly string[], signals: readonly string[], noticeUrl: string|null }} StatusPayload
 * @typedef {{ state: MonitoringState, from: string|null, version: string|null,
 *   signals: readonly string[], privacyNoticeUrl: string|null }} EmbedNotice
 * @typedef {{ state: MonitoringState, from: string|null }} AgentCounting
 */

const STATES = Object.freeze(['off', 'scheduled', 'on']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const URL_MAX = 500;

/** @type {Readonly<StatusPayload>} */
const STATUS_OFF = Object.freeze({
    state: /** @type {MonitoringState} */ ('off'), from: null, version: null,
    surfaces: Object.freeze([]), signals: Object.freeze([]), noticeUrl: null,
});
/** @type {Readonly<EmbedNotice>} */
const EMBED_OFF = Object.freeze({
    state: /** @type {MonitoringState} */ ('off'), from: null, version: null,
    signals: Object.freeze([]), privacyNoticeUrl: null,
});
/** @type {Readonly<AgentCounting>} */
const COUNTING_OFF = Object.freeze({ state: /** @type {MonitoringState} */ ('off'), from: null });

/**
 * An absolute https URL, or null.
 * @param {unknown} value
 * @returns {string|null}
 */
function httpsOrNull(value) {
    if (typeof value !== 'string' || !value || value.length > URL_MAX) return null;
    try {
        return new URL(value).protocol === 'https:' ? value : null;
    } catch (_) {
        return null;
    }
}

/**
 * The known ids of `list`, deduplicated, in vocabulary order.
 * @param {unknown} list
 * @param {readonly string[]} vocabulary
 * @returns {string[]}
 */
function knownIds(list, vocabulary) {
    const given = new Set(Array.isArray(list) ? list.filter((x) => typeof x === 'string') : []);
    return vocabulary.filter((id) => given.has(id));
}

/**
 * The resolver's answer reduced to what may be announced, or null when nothing
 * may: off, no version in the exact stored shape, no surface left, or no
 * 'outcomes' signal (the resolver never says 'on' without it).
 * @param {any} mon
 * @returns {{ state: MonitoringState, from: string, version: string, surfaces: string[], signals: string[] } | null}
 */
function announced(mon) {
    if (!mon || typeof mon !== 'object') return null;
    const state = STATES.includes(mon.state) ? /** @type {MonitoringState} */ (mon.state) : 'off';
    const version = typeof mon.version === 'string' && VERSION_RE.test(mon.version) ? mon.version : null;
    if (state === 'off' || !version) return null;
    const surfaces = knownIds(mon.surfaces, V.SURFACES);
    const signals = knownIds(mon.signals, V.SIGNALS);
    if (!surfaces.length || !signals.includes('outcomes')) return null;
    const from = typeof mon.from === 'string' && DAY_RE.test(mon.from) ? mon.from : version.slice(0, 10);
    return { state, from, version, surfaces, signals };
}

/**
 * Is `surface` announced (scheduled or on) in this answer?
 * @param {any} mon
 * @param {string} surface
 */
function announcesSurface(mon, surface) {
    const a = announced(mon);
    return !!a && a.surfaces.includes(surface);
}

/**
 * The `chatMonitoring` block of /api/privacy/shield-status. The notice link is
 * the organisation's employee notice.
 * @param {any} mon
 * @returns {StatusPayload}
 */
function statusPayload(mon) {
    const a = announced(mon);
    if (!a) return STATUS_OFF;
    return {
        state: a.state,
        from: a.from,
        version: a.version,
        surfaces: a.surfaces,
        signals: a.signals,
        noticeUrl: httpsOrNull(mon.noticeUrl),
    };
}

/**
 * The `complianceNotice` of an embedded agent's public page: present only when
 * website visitors (`agent_public`) are announced. The link is the visitor
 * notice (the chat-signals notice, else the organisation's privacy notice).
 * @param {any} mon the resolver's answer for the AGENT's organisation
 * @returns {EmbedNotice}
 */
function embedNotice(mon) {
    const a = announced(mon);
    if (!a || !a.surfaces.includes('agent_public')) return EMBED_OFF;
    return {
        state: a.state,
        from: a.from,
        version: a.version,
        signals: a.signals,
        privacyNoticeUrl: httpsOrNull(mon.visitorNoticeUrl),
    };
}

/**
 * The `complianceCounting` of GET /agents/:id: whether this agent's chat is
 * counted for THIS caller. Only a member of the agent's own organisation is
 * counted (the recorder's rule, chatSignals.agentTurnTarget), so only they are
 * told; another org's member, a super admin (no caller org) and an agent
 * without an org read off.
 * @param {any} mon the resolver's answer for the agent's organisation
 * @param {{ callerOrgId?: string|null, agentOrgId?: string|null }} who
 * @returns {AgentCounting}
 */
function agentCounting(mon, { callerOrgId, agentOrgId }) {
    if (typeof agentOrgId !== 'string' || !agentOrgId) return COUNTING_OFF;
    if (typeof callerOrgId !== 'string' || callerOrgId !== agentOrgId) return COUNTING_OFF;
    const a = announced(mon);
    if (!a || !a.surfaces.includes('agent')) return COUNTING_OFF;
    return { state: a.state, from: a.from };
}

module.exports = {
    STATUS_OFF,
    EMBED_OFF,
    COUNTING_OFF,
    statusPayload,
    embedNotice,
    agentCounting,
    announcesSurface,
    httpsOrNull,
};
