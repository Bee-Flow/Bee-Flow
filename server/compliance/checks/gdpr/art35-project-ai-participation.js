// @typecheck
'use strict';

/**
 * GDPR Art. 35 (and AI Act Art. 26(9)) — AI that joins project conversations
 * by itself.
 *
 * Subjects are the team chats whose AI answers on its own ('always', or
 * 'auto': the AI decides when to take part) and the comment threads in 'auto'
 * mode. There the AI reads what members write without anyone asking it to,
 * so the question an assessor asks is whether that processing was assessed —
 * especially when the project holds special-category data.
 *
 *   fail  the project holds special-category or identification data (health,
 *         id numbers), the AI joins by itself, and no current DPIA covers it
 *   warn  the Privacy Shield is off: the AI then reads raw personal data and
 *         nothing tells whether this conversation holds any
 *   pass  the shield is on, and either no special-category data is known or
 *         a current DPIA covers it
 *
 * A DPIA covers the chat when one is on record for the chat's agent persona,
 * for the project (`project:<id>`), or organisation-wide for autonomous AI in
 * projects (`project_ai_participation`) — dpia_assessments, current = approved
 * and not expired.
 *
 * Auto-fix `project_ai_mode_mention` switches the team chats this check fails
 * back to "on mention" (only those, or the one named), announcing it on the
 * project's live feed like any other chat change. Ids and counts in evidence.
 */

const pd = require('../../projects/projectData');
const signals = require('../../projects/personalDataSignals');

const ORG_WIDE_DPIA_KEY = 'project_ai_participation';
const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');

const SUBJECTS_SQL = Object.freeze({
    chats: `
        SELECT pc.id, pc.project_id, pc.agent_id, pc.ai_mode
        FROM project_chats pc JOIN projects p ON p.id = pc.project_id
        WHERE ${ORG} AND ${WS} AND pc.archived = false AND pc.ai_mode IN ('always', 'auto')
        ORDER BY pc.id
        LIMIT ${pd.ROW_LIMIT + 1}`,
    threads: `
        SELECT t.id, t.project_id, NULL::text AS agent_id, t.ai_mode
        FROM project_comment_threads t JOIN projects p ON p.id = t.project_id
        WHERE ${ORG} AND ${WS} AND t.status = 'open' AND t.ai_mode = 'auto'
        ORDER BY t.id
        LIMIT ${pd.ROW_LIMIT + 1}`,
});

const DPIA_SQL = `
    SELECT DISTINCT ON (agent_id) agent_id, approved_at, expires_at
    FROM dpia_assessments
    WHERE COALESCE(NULLIF(organization_id, ''), '${pd.NO_ORG_ORG_ID}') = $1 AND agent_id = ANY($2::text[])
    ORDER BY agent_id, created_at DESC`;

const MENTION_SQL = `
    UPDATE project_chats pc SET ai_mode = 'mention', updated_at = NOW()
    FROM projects p
    WHERE p.id = pc.project_id AND ${ORG} AND pc.id = ANY($2::text[]) AND pc.ai_mode IN ('always', 'auto')
    RETURNING pc.id, pc.project_id`;

const PREFIX = { chats: 'project_chat:', threads: 'project_comment_thread:' };

function defaultDeps() {
    return {
        query: pd.defaultQuery(),
        signals: signals.sharedReader(),
        shieldOn: async (orgId) => {
            const { resolveShieldFor } = require('../../../core/privacy/orgShield');
            const shield = await resolveShieldFor({ orgId: orgId === pd.NO_ORG_ORG_ID ? null : orgId, userId: null });
            return !!shield && shield.enabled !== false;
        },
        announce: (projectId, chatId, actorId) => {
            const { emitProjectEvent } = require('../../../core/projectFeed');
            return emitProjectEvent(projectId, { kind: 'chat.updated', actorId: actorId || null, targetType: 'chat', targetId: chatId, payload: { chatId } });
        },
        now: () => Date.now(),
    };
}

/**
 * Every conversation where the AI joins by itself, with what evaluate() needs
 * to judge it — so the runner hands each one straight to evaluate() instead of
 * evaluate() listing all of them again per subject (which made a sweep, and an
 * auto-fix click, quadratic in the number of autonomous chats). `complete` is
 * false when a query hit its limit: the list is then a window, and the runner
 * judges it without retiring anything outside it.
 */
async function _listing(orgId, deps) {
    const subjects = [];
    let complete = true;
    for (const [kind, sql] of Object.entries(SUBJECTS_SQL)) {
        let rows;
        try {
            rows = (await deps.query(sql, [orgId])) || [];
        } catch (e) {
            if (pd.isNotProvisioned(e)) continue;
            throw e;
        }
        if (rows.length > pd.ROW_LIMIT) {
            complete = false;
            rows = rows.slice(0, pd.ROW_LIMIT);
        }
        for (const r of rows) {
            subjects.push({
                id: `${PREFIX[kind]}${r.id}`,
                label: `${kind === 'chats' ? 'chat' : 'thread'}:${String(r.id).slice(0, 8)}`,
                kind,
                projectId: String(r.project_id),
                agentId: r.agent_id || null,
                aiMode: r.ai_mode,
            });
        }
    }
    return { subjects, complete };
}

async function _subjects(orgId, deps) {
    return (await _listing(orgId, deps)).subjects;
}

/** A subject as listSubjects built it, or null when it carries only an id. */
function _asBuilt(subject) {
    return subject && typeof subject.projectId === 'string' && PREFIX[subject.kind] ? subject : null;
}

function _isCurrent(row, now) {
    if (!row || !row.approved_at) return false;
    if (!row.expires_at) return true;
    return Date.parse(new Date(row.expires_at).toISOString()) > now;
}

/**
 * Pure verdict.
 * @param {{ subject: {id: string, kind: string, projectId: string, aiMode: string}, kinds: string[], shieldOn: boolean, dpiaCurrent: boolean }} input
 */
function verdict({ subject, kinds, shieldOn, dpiaCurrent }) {
    const special = signals.hasSpecialKinds(kinds);
    const what = subject.kind === 'chats' ? 'team chat' : 'comment thread';
    const ref = `${subject.kind === 'chats' ? 'chat' : 'thread'}:${String(subject.id).split(':').pop().slice(0, 8)}`;
    const evidence = {
        subject_kind: subject.kind === 'chats' ? 'team_chat' : 'comment_thread',
        project_id: subject.projectId,
        ai_mode: subject.aiMode,
        kinds: kinds || [],
        special_categories: special,
        shield: shieldOn,
        dpia_current: dpiaCurrent,
        link: pd.projectLink(subject.projectId, subject.kind === 'chats' ? 'chats' : null),
    };
    if (special && !dpiaCurrent) {
        return {
            status: 'fail',
            evidence,
            details: `In ${pd.shortRef(subject.projectId)} the AI joins ${what} ${ref} by itself while the project holds special-category or identification data, and no current DPIA covers it. Record a DPIA, or switch the AI to "on mention".`,
        };
    }
    if (!shieldOn) {
        return {
            status: 'warn',
            evidence,
            details: `The Privacy Shield is off, so the AI that joins ${what} ${ref} by itself reads raw content, and nothing tells whether it holds personal data.`,
        };
    }
    return {
        status: 'pass',
        evidence,
        details: special
            ? `The AI joins ${what} ${ref} by itself under a current DPIA, with the Privacy Shield on.`
            : `The AI joins ${what} ${ref} by itself with the Privacy Shield on, and no special-category data is known in the project.`,
    };
}

module.exports = {
    id: 'GDPR-Art35-project-ai-participation',
    regulation: 'GDPR',
    article: '35',
    frameworks: [{ regulation: 'AIA', ref: 'Art. 26(9)' }],
    severity: 'high',
    scope: 'per-source',
    verification: 'hybrid',
    projectCheck: true,
    subjectNoun: 'conversations',
    titleKey: 'compliance.checks.gdpr_project_ai_participation.title',
    descriptionKey: 'compliance.checks.gdpr_project_ai_participation.desc',
    remediationKey: 'compliance.checks.gdpr_project_ai_participation.fix',
    remediationLink: 'admin/compliance/dpia',
    autoFixId: 'project_ai_mode_mention',
    ORG_WIDE_DPIA_KEY,

    fingerprintOf(evidence) {
        return [!!evidence?.special_categories, !!evidence?.shield, !!evidence?.dpia_current, evidence?.ai_mode || null];
    },

    // The list is every conversation where the AI joins by itself, so one that
    // left it (switched to "on mention" or off, archived, closed, deleted) is
    // retired — also by the re-run right after the auto-fix switched it.
    retiresVanished: true,
    retiredDetails: 'The AI no longer joins this conversation by itself: it was switched to another mode, archived, closed or deleted.',

    async listSubjects(orgId, deps = defaultDeps()) {
        return _listing(orgId, deps);
    },

    async evaluate(orgId, subject, deps = defaultDeps()) {
        // The runner passes the subject as listSubjects built it; only a caller
        // holding a bare id makes this look it up.
        const s = _asBuilt(subject) || (await _subjects(orgId, deps)).find(x => x.id === subject?.id);
        if (!s) return { status: 'not_applicable', evidence: {}, details: 'The AI no longer joins this conversation by itself.' };
        const sig = await deps.signals.signalsFor(orgId);
        if (sig.unreadable.length) {
            return { status: 'warn', evidence: { project_id: s.projectId, unreadable: sig.unreadable }, details: 'Whether this project holds personal data could not be read, so this conversation was not judged.' };
        }
        const signal = sig.byProject.get(s.projectId);
        if (!signal && (sig.truncated || []).length) {
            return { status: 'warn', evidence: { project_id: s.projectId, truncated: sig.truncated }, details: 'Whether this project holds personal data could not be read in full, so this conversation was not judged.' };
        }
        const kinds = signal?.kinds || [];
        let shieldOn;
        try { shieldOn = await deps.shieldOn(orgId); } catch { shieldOn = false; }
        let dpiaCurrent = false;
        if (signals.hasSpecialKinds(kinds)) {
            const keys = [ORG_WIDE_DPIA_KEY, `project:${s.projectId}`, ...(s.agentId ? [String(s.agentId)] : [])];
            try {
                const rows = await deps.query(DPIA_SQL, [orgId, keys]);
                dpiaCurrent = (rows || []).some(r => _isCurrent(r, deps.now()));
            } catch (e) {
                if (!pd.isNotProvisioned(e)) {
                    return { status: 'warn', evidence: { project_id: s.projectId, error: 'dpia_unreadable' }, details: 'The DPIA register could not be read, so this conversation was not judged.' };
                }
            }
        }
        return verdict({ subject: s, kinds, shieldOn, dpiaCurrent });
    },

    /** Switch failing (or the named) autonomous team chats back to "on mention". */
    async autoFix(orgId, { subjectId = null, actorId = null } = {}, deps = defaultDeps()) {
        const all = (await _subjects(orgId, deps)).filter(s => s.kind === 'chats');
        let targets;
        if (subjectId) {
            targets = all.filter(s => s.id === String(subjectId));
        } else {
            // Judged from the one list just read — never re-listed per chat.
            targets = [];
            for (const s of all) {
                const r = await module.exports.evaluate(orgId, s, deps);
                if (r.status === 'fail') targets.push(s);
            }
        }
        if (!targets.length) return { changed: 0, summary: 'No team chat needed switching.' };
        const updated = await deps.query(MENTION_SQL, [orgId, targets.map(s => s.id.slice(PREFIX.chats.length))]);
        for (const r of updated || []) {
            try { await deps.announce(String(r.project_id), String(r.id), actorId); } catch { /* the switch stands; the live feed is best-effort */ }
        }
        return { changed: (updated || []).length, summary: `Switched ${(updated || []).length} team chat(s) to "AI answers on mention".` };
    },

    _verdict: verdict,
    _subjects,
};
