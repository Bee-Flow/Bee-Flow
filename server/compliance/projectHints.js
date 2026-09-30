// @typecheck
'use strict';

/**
 * The ONE gentle compliance hint a project may show to someone who can fix
 * it — and the rules that keep it gentle.
 *
 * Compliance findings belong to admins and the DPO. A project owner or editor
 * sees, at most, one hint about their own project, and only from this
 * ALLOW-LIST of things THEY can act on:
 *
 *   project_foreign_members    owner          members from another organisation
 *   project_dangling_members   owner          memberships of accounts or groups that are gone
 *   project_orphaned_content   owner          shared chats / notebooks of people who left
 *   project_files_unscanned    owner, editor  files never checked for personal data
 *
 * Each hint's Review opens the section where the owner can act: members,
 * knowledge, or — for items of people who left — the chats when shared
 * chats are among them, the notebooks otherwise. Never the overview the hint
 * already stands on: a Review that goes nowhere is no way to act.
 *
 * Never "this project contains personal data", never a retention or DPIA
 * finding: those are the DPO's (GDPR-Art30/5(1)(e)/35 project checks), and an
 * end user cannot resolve them. Never a hint to a viewer. Never an "all good"
 * badge: no hint is simply nothing.
 *
 * A hint is read from the latest result rows of the three global project
 * checks (their evidence names the affected projects by id, with counts). It
 * is left out when:
 *   - the check's framework is not active, or the row is stale (the caller
 *     reads only fresh rows);
 *   - an admin acknowledged, accepted or snoozed that finding;
 *   - this person dismissed it (until what it reports changes — the
 *     fingerprint is the key and the count) or snoozed it (until a date).
 *
 * Pure: the route (routes/projects/complianceHints.js) does the reading.
 */

const crypto = require('crypto');
const findingState = require('./findingState');
const { projectPath } = require('../utils/appPaths');

const HINTS = Object.freeze([
    {
        key: 'project_foreign_members', checkId: 'GDPR-Art32-project-access', regulation: 'GDPR',
        roles: ['owner'], severity: 'high', section: 'members',
        count: (o) => Number(o.foreign) || 0,
    },
    {
        key: 'project_dangling_members', checkId: 'GDPR-Art32-project-access', regulation: 'GDPR',
        roles: ['owner'], severity: 'medium', section: 'members',
        count: (o) => Number(o.dangling) || 0,
    },
    {
        key: 'project_orphaned_content', checkId: 'ISO27001-A.5.18-project-orphaned-content', regulation: 'ISO27001',
        roles: ['owner'], severity: 'medium',
        // Shared chats of people who left are listed under Chats; their
        // notebooks under Notebooks. The chats first: they are the more.
        section: (o) => ((Number(o.threads) || 0) > 0 ? 'chats' : 'notebooks'),
        count: (o) => (o.owner_left ? 0 : (Number(o.threads) || 0) + (Number(o.notebooks) || 0)),
    },
    {
        key: 'project_files_unscanned', checkId: 'GDPR-Art32-project-files-unscanned', regulation: 'GDPR',
        roles: ['owner', 'editor'], severity: 'low', section: 'knowledge',
        count: (o) => Number(o.unscanned) || 0,
    },
]);

const HINT_KEYS = Object.freeze(HINTS.map(h => h.key));
const HINT_CHECK_IDS = Object.freeze([...new Set(HINTS.map(h => h.checkId))]);
const SNOOZE_DAYS = Object.freeze([7, 30]);

function hintFingerprint(key, count) {
    return crypto.createHash('sha256').update(`${key}␟${count}`).digest('hex').slice(0, 32);
}

/**
 * Every hint that applies to this project for this role, in priority order,
 * before anyone's dismissals.
 * @param {{ projectId: string, role: string, rows: any[], active: Set<string>, states: any[], now?: number,
 *           defs?: (id: string) => any }} input
 */
function candidates({ projectId, role, rows, active, states, now = Date.now(), defs = () => null }) {
    if (!projectId || !role || role === 'viewer') return [];
    const index = findingState.indexStates(states);
    const byCheck = new Map();
    for (const r of rows || []) {
        if (r && (r.scope_id == null || r.scope_id === '')) byCheck.set(r.check_id, r);
    }
    const out = [];
    for (const h of HINTS) {
        if (!h.roles.includes(role)) continue;
        if (!active || !active.has(h.regulation)) continue;
        const row = byCheck.get(h.checkId);
        if (!row || (row.status !== 'warn' && row.status !== 'fail')) continue;
        // An admin already decided about this finding: the project owner is
        // not asked to act on something the organisation accepted.
        if (findingState.applies(findingState.stateFor(index, row), row, defs(h.checkId), now)) continue;
        const offenders = Array.isArray(row.evidence?.offenders) ? row.evidence.offenders : [];
        const mine = offenders.find(o => String(o?.project_id) === String(projectId));
        const count = mine ? h.count(mine) : 0;
        if (count <= 0) continue;
        out.push({
            key: h.key,
            severity: h.severity,
            titleKey: `compliance.project_hint.${h.key}`,
            params: { count },
            action: { kind: 'navigate', target: projectPath(projectId, typeof h.section === 'function' ? h.section(mine) : h.section) },
            fingerprint: hintFingerprint(h.key, count),
        });
    }
    return out;
}

/** The first candidate this person has neither dismissed (as it is now) nor snoozed. */
function pick(list, dismissals, now = Date.now()) {
    for (const c of list || []) {
        const d = dismissals ? dismissals[c.key] : null;
        if (d) {
            const until = d.snoozedUntil ? Date.parse(d.snoozedUntil) : NaN;
            if (Number.isFinite(until) && until > now) continue;
            if (d.dismissedAt && d.fingerprint === c.fingerprint) continue;
        }
        return c;
    }
    return null;
}

/** The wire shape (never the fingerprint). */
function publicHint(c) {
    if (!c) return null;
    const { fingerprint: _f, ...pub } = c;
    return pub;
}

module.exports = { HINTS, HINT_KEYS, HINT_CHECK_IDS, SNOOZE_DAYS, candidates, pick, publicHint, hintFingerprint };
