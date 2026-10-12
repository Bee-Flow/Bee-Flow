// @typecheck
'use strict';

/**
 * Chat signals: the one closed vocabulary.
 *
 * Chat signals check whether the Privacy Shield works (GDPR Art. 32(1)(d)):
 * per chat type, each counted message becomes counters taken from the
 * decision the Privacy Shield or DLP already made on it, inside the same
 * request. This module names every value such a counter may carry, and every
 * setting value the admin route accepts.
 *
 * Pure and frozen, with no requires, so core, stores, compliance, routes and
 * entitlements all read this ONE list without a layering edge
 * (server/layering.test.js). A value that is not here is refused by the store
 * (chatSignalStore.addCounts throws) and by the route (zod enums).
 *
 * What is deliberately NOT here, and never will be:
 *   - 'health' in KINDS. Health data is dropped by the recorder, never mapped
 *     to 'other' (legal verdict amendment 3);
 *   - any surface between people (HUMAN_TO_HUMAN). Those may never enter
 *     SURFACES; chatMonitoringVocab.test.js guards it.
 */

/**
 * @param {string[]} a
 * @returns {readonly string[]}
 */
const list = (a) => Object.freeze([...a]);

/** Chat types this release can count. */
const SURFACES = list(['direct', 'agent', 'agent_public']);
/** Shown disabled in the admin card ("Coming later"). */
const FUTURE_SURFACES = list(['notebook', 'voice']);
const EMPLOYEE_SURFACES = list(['direct', 'agent', 'notebook', 'voice']);
const VISITOR_SURFACES = list(['agent_public']);
/** Messages between people. Never a surface, in any phase. */
const HUMAN_TO_HUMAN = list(['project_chat', 'comment', 'support', 'talk', 'mail']);

/** What this release can count; 'outcomes' is required whenever chat signals are on. */
const SIGNALS = list(['outcomes', 'kinds']);
const FUTURE_SIGNALS = list(['credentials', 'rights_help', 'incident_help']);
/** The `signal` column of a stored row: one outcome row per turn, one kind row per distinct kind. */
const ROW_SIGNALS = list(['outcome', 'kind']);

const OUTCOMES = list([
    'clean', 'protected', 'blocked', 'sent_unprotected',
    'scan_failed_open', 'scan_failed_closed', 'unscanned',
]);
/** Outcomes for which the Shield found something, so kinds may be counted. */
const FOUND_OUTCOMES = list(['protected', 'blocked', 'sent_unprotected']);
/** Kinds of personal data. Never 'health'. */
const KINDS = list([
    'name', 'email', 'phone', 'address', 'birth', 'financial',
    'online_id', 'id_number', 'credential', 'other',
]);
const DESTINATIONS = list(['internal', 'external', 'unknown']);
const PROVIDER_TYPES = list([
    'openai', 'mistral', 'claude', 'google', 'google_vertex', 'azure',
    'scaleway', 'eugpt', 'local', 'other',
]);
const PROTECTION = list(['', 'protected', 'exposed']);
const GRANULARITY = list(['week', 'day']);

const LEGAL_BASES = list(['art6_1_f', 'art6_1_e', 'art6_1_c']);
const WORKS_COUNCIL = list(['consent', 'court_replacement', 'not_applicable', 'pending']);
/** Works-council states that count as consent and therefore carry a date and a scope. */
const WORKS_COUNCIL_CONSENT = list(['consent', 'court_replacement']);
const WORKS_COUNCIL_REASONS = list(['no_works_council', 'pvt_without_consent_right', 'cao_regulates', 'outside_nl']);
const DPIA_RISK_LEVELS = list(['low', 'medium', 'high']);

/** What this release supports. `objection`: the Art. 21 "Don't count my chat turns" preference exists. */
const PHASE = Object.freeze({ surfaces: SURFACES, signals: SIGNALS, objection: true });
const RETENTION = Object.freeze({ min: 30, max: 90, default: 90 });
/** Readers hide a figure below these: distinct people for outcomes and kinds, and a single cell. */
const K = Object.freeze({ outcomes: 5, kinds: 10, cell: 5 });
/** C1 judges a surface only from this many turns in the window. */
const MIN_TURNS = 25;
const DPIA_DEFAULT_VALIDITY_DAYS = 365;
const NOTICE_LEAD_DAYS = 7;
/** The dpia_assessments key of the organisation-wide chat signals DPIA. */
const CHAT_MONITORING_DPIA_KEY = 'chat_monitoring';
/** `${surface}@${version}`: a client says it showed the notice for exactly this configuration. */
const MARKER_RE = Object.freeze(/^(direct|agent|agent_public)@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

/** @param {string} surface */
function isVisitorSurface(surface) {
    return VISITOR_SURFACES.includes(surface);
}

/** @param {string} surface */
function isEmployeeSurface(surface) {
    return EMPLOYEE_SURFACES.includes(surface);
}

/**
 * Employee chats are stored per ISO week, website visitors per UTC day
 * (amendment 6): a daily row of a small team is too close to a person.
 * @param {string} surface
 * @returns {'week'|'day'}
 */
function granularityFor(surface) {
    return isVisitorSurface(surface) ? 'day' : 'week';
}

module.exports = Object.freeze({
    SURFACES,
    FUTURE_SURFACES,
    EMPLOYEE_SURFACES,
    VISITOR_SURFACES,
    HUMAN_TO_HUMAN,
    SIGNALS,
    FUTURE_SIGNALS,
    ROW_SIGNALS,
    OUTCOMES,
    FOUND_OUTCOMES,
    KINDS,
    DESTINATIONS,
    PROVIDER_TYPES,
    PROTECTION,
    GRANULARITY,
    LEGAL_BASES,
    WORKS_COUNCIL,
    WORKS_COUNCIL_CONSENT,
    WORKS_COUNCIL_REASONS,
    DPIA_RISK_LEVELS,
    PHASE,
    RETENTION,
    K,
    MIN_TURNS,
    DPIA_DEFAULT_VALIDITY_DAYS,
    NOTICE_LEAD_DAYS,
    CHAT_MONITORING_DPIA_KEY,
    MARKER_RE,
    granularityFor,
    isEmployeeSurface,
    isVisitorSurface,
});
