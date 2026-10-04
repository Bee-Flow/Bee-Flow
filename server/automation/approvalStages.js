/**
 * approvalStages — the stage chain's rulebook. Pure, so both the automation
 * engine and the App Studio executor reach the same answer from the same
 * input, and so the tests can enumerate the whole matrix without a database.
 *
 * A staged approval is an ORDERED list of up to five named steps. Each stage
 * names its own approvers and its own rule; only the current stage's people
 * are asked, and only when their turn arrives. The row's `stage` column holds
 * the CURRENT stage's key, and every lookup here is by key — never by index
 * arithmetic — which is what lets the legacy two-stage rows (keys 'panel'
 * and 'final') flow through this module unchanged.
 *
 * Three shapes desugar into one canonical chain, so nothing downstream has to
 * know which era an approval was authored in:
 *
 *   stages: [...]                    → used as authored (keys s1..s5)
 *   approvers + rule (+ final)       → one or two stages ('panel', 'final')
 *   assignee + finalApprover         → two stages — this replaces the
 *                                      "one-seat panel" sleight of hand the
 *                                      panel release used in two places, and
 *                                      says out loud what it was doing
 *   assignee alone                   → null (no chain; the single-assignee
 *                                      row shape is left exactly as it was)
 *
 * Conditions: a stage may carry `when`, evaluated ONCE at request time (the
 * moment the chain is snapshotted) against whatever scope the caller has —
 * run state for an automation, the action scope for an app. A stage whose
 * condition is false is marked `skipped: true` and KEPT: "why did this never
 * reach finance?" is an audit question, and a stage that silently vanished
 * cannot answer it.
 */

/** Product cap. Mirrored by the CHECK constraint in the stages migration. */
const MAX_APPROVAL_STAGES = 5;
/** Seats in one stage. Matches the panel cap validatePanel already applies. */
const MAX_SEATS_PER_STAGE = 10;
/** Seats across the whole chain — bounds the participant index and the fan-out. */
const MAX_TOTAL_SEATS = 30;
const MAX_STAGE_NAME_LEN = 60;
const MAX_STAGE_DESCRIPTION_LEN = 200;

const STAGE_RULES = ['all', 'first', 'quorum'];

/** One seat: exactly one of userId / groupId, or null. */
function cleanSeat(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.userId === 'string' && raw.userId.trim()) return { userId: raw.userId.trim() };
    if (typeof raw.groupId === 'string' && raw.groupId.trim()) return { groupId: raw.groupId.trim() };
    return null;
}

function seatKey(seat) {
    return seat.userId ? `u:${seat.userId}` : `g:${seat.groupId}`;
}

/** Seats of one stage: cleaned, de-duplicated within the stage, capped. */
function cleanSeats(raw) {
    const seen = new Set();
    const out = [];
    for (const entry of Array.isArray(raw) ? raw : []) {
        const seat = cleanSeat(entry);
        if (!seat) continue;
        const key = seatKey(seat);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(seat);
        if (out.length >= MAX_SEATS_PER_STAGE) break;
    }
    return out;
}

/**
 * One authored stage → canonical form. `index` supplies the fallback key and
 * the fallback name, so a stage the author never named still reads as
 * something ("Stage 2") rather than as blank chrome.
 */
function cleanStage(raw, index, { interpolate = null } = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const approvers = cleanSeats(raw.approvers);
    if (!approvers.length) return null;

    const render = (v) => {
        if (typeof v !== 'string' || !v.trim()) return null;
        const text = typeof interpolate === 'function' ? interpolate(v) : v;
        return typeof text === 'string' ? text.trim() : null;
    };

    const rule = STAGE_RULES.includes(raw.rule) ? raw.rule : 'all';
    const stage = {
        // A key the author supplied is honoured (it is what votes are filed
        // under, so re-saving an automation must not orphan votes already cast);
        // otherwise positional.
        key: (typeof raw.key === 'string' && raw.key.trim()) ? raw.key.trim().slice(0, 40) : `s${index + 1}`,
        name: (render(raw.name) || `Stage ${index + 1}`).slice(0, MAX_STAGE_NAME_LEN),
        description: (render(raw.description) || null)?.slice(0, MAX_STAGE_DESCRIPTION_LEN) ?? null,
        approvers,
        rule,
        quorum: rule === 'quorum'
            ? Math.min(Math.max(Math.round(Number(raw.quorum)) || 1, 1), approvers.length)
            : null,
    };
    if (raw.skipped === true) stage.skipped = true;
    return stage;
}

/**
 * Any authored approval config → the canonical stage chain, or null when the
 * approval has no chain (a plain single assignee).
 *
 * `interpolate` renders stage names/descriptions against the caller's scope,
 * exactly as the prompt and details are rendered — an approver reading
 * "Finance sign-off for {{steps.x.output.supplier}}" must see the supplier.
 *
 * `evaluateWhen(expr)` decides a stage's condition. Absent, every condition
 * is treated as met (the caller does not support conditions); a stage whose
 * condition evaluates false is kept and marked `skipped`.
 */
function desugarApprovalStages(cfg, { interpolate = null, evaluateWhen = null } = {}) {
    const a = (cfg && typeof cfg === 'object') ? cfg : {};

    let authored = null;
    if (Array.isArray(a.stages) && a.stages.length) {
        authored = a.stages.slice(0, MAX_APPROVAL_STAGES);
    } else {
        // Legacy shapes. `approvers` is a panel; `assignee` is one person;
        // `finalApprover` adds a closing stage to either.
        const panelSeats = cleanSeats(a.approvers);
        const assignee = cleanSeat(a.assignee);
        const finalApprover = cleanSeat(a.finalApprover);
        const firstSeats = panelSeats.length ? panelSeats : (assignee ? [assignee] : []);
        if (!firstSeats.length) return null;
        if (!panelSeats.length && !finalApprover) return null;   // assignee alone: no chain

        authored = [{
            key: 'panel',
            name: 'Approval',
            // A lone assignee promoted to a stage decides alone: 'first' is
            // the only rule that means the same thing it did before.
            approvers: firstSeats,
            rule: panelSeats.length ? (STAGE_RULES.includes(a.rule) ? a.rule : 'all') : 'first',
            quorum: panelSeats.length ? a.quorum : null,
        }];
        if (finalApprover) {
            authored.push({
                key: 'final', name: 'Final sign-off',
                approvers: [finalApprover], rule: 'first', quorum: null,
            });
        }
    }

    const stages = [];
    const seen = new Set();
    let totalSeats = 0;
    for (const raw of authored) {
        const stage = cleanStage(raw, stages.length, { interpolate });
        if (!stage) continue;
        // Keys must be unique — votes are filed under them.
        if (seen.has(stage.key)) stage.key = `s${stages.length + 1}_${seen.size}`;
        seen.add(stage.key);

        // Conditions decide membership ONCE, here, and are recorded either way.
        const when = typeof raw?.when === 'string' ? raw.when.trim() : '';
        if (when && typeof evaluateWhen === 'function') {
            let met = true;
            try { met = !!evaluateWhen(when); } catch { met = true; }   // a broken condition must not silently drop an approver
            if (!met) stage.skipped = true;
        }

        // The whole-chain seat budget bounds the participant index and the
        // notification fan-out; stages past it are dropped, not truncated
        // mid-stage (half a panel would change that stage's rule silently).
        if (!stage.skipped) {
            if (totalSeats + stage.approvers.length > MAX_TOTAL_SEATS) break;
            totalSeats += stage.approvers.length;
        }
        stages.push(stage);
        if (stages.length >= MAX_APPROVAL_STAGES) break;
    }

    // A chain of nothing but skipped stages has nobody to ask — treat it as
    // no chain at all so the caller falls back to its owner/assignee path
    // rather than creating an approval that can never be decided.
    if (!stages.some(s => !s.skipped)) return null;
    return stages.length ? stages : null;
}

/** The stages that actually run, in order (skipped ones removed). */
function activeStages(stages) {
    return (Array.isArray(stages) ? stages : []).filter(s => s && !s.skipped);
}

/** The stage a row is currently on, by key. */
function stageByKey(stages, key) {
    if (!Array.isArray(stages)) return null;
    return stages.find(s => s && s.key === key) || null;
}

/** The first stage that will be asked — where a fresh chain starts. */
function firstStageKey(stages) {
    const active = activeStages(stages);
    return active.length ? active[0].key : null;
}

/**
 * The stage after `key`, or null when `key` is the last — which is what
 * turns "this stage passed" into either "ask the next people" or "the whole
 * approval is approved".
 */
function nextStageKey(stages, key) {
    const active = activeStages(stages);
    const i = active.findIndex(s => s.key === key);
    if (i < 0 || i === active.length - 1) return null;
    return active[i + 1].key;
}

/** 1-based position of a stage among the active ones (for "Stage 2 of 3"). */
function stagePosition(stages, key) {
    const active = activeStages(stages);
    const i = active.findIndex(s => s.key === key);
    return i < 0 ? null : { index: i + 1, total: active.length };
}

/** Every distinct seat across the chain — the participant index. */
function collectParticipants(stages) {
    const seen = new Set();
    const out = [];
    for (const stage of activeStages(stages)) {
        for (const seat of stage.approvers || []) {
            const key = seatKey(seat);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(seat);
        }
    }
    return out;
}

module.exports = {
    MAX_APPROVAL_STAGES,
    MAX_SEATS_PER_STAGE,
    MAX_TOTAL_SEATS,
    MAX_STAGE_NAME_LEN,
    MAX_STAGE_DESCRIPTION_LEN,
    STAGE_RULES,
    desugarApprovalStages,
    activeStages,
    stageByKey,
    firstStageKey,
    nextStageKey,
    stagePosition,
    collectParticipants,
    _stagesTest: { cleanSeat, cleanSeats, cleanStage, seatKey },
};
