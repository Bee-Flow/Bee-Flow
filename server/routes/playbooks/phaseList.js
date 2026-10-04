/**
 * A playbook's PHASE LIST, as this router reads it.
 *
 * Everything here answers a question about the stored row rather than about a
 * request: what kind a phase is, which phase governs another one's artifacts,
 * which phases close a playbook that built an app, what the option block the
 * playbook was created with says, and the one row the sidebar shows.
 */

'use strict';

const { TIERS } = require('./contract');

/** The interface language a playbook was started in — the demo speaks it. */
function localeOf(playbook) {
    return (playbook && playbook.options && playbook.options.locale) || null;
}

/**
 * The tier the playbook was started on, or null when none is on file. `options.tier`
 * was written at create time and then read only by the CLIENT, for the two
 * builder phases — so choosing Think or Deep Thinking in the New dialog
 * changed nothing about the design, the review or either assistant.
 *
 * It is what was STORED, not what runs: phaseFlow.phaseTier measures it
 * against the owner's list before a model is called, and chooses for `auto`
 * and for a row with no tier. Null used to be `fast`, decided here without
 * asking.
 */
function tierOf(pb) {
    const t = pb && pb.options && pb.options.tier;
    return TIERS.has(t) ? t : null;
}

/** A phase's kind — the run page stages by it; older rows carry the key only. */
function kindOf(p) { return (p && (p.kind || p.key)) || null; }
function firstOfKind(phases, kind) { return (Array.isArray(phases) ? phases : []).find((p) => kindOf(p) === kind) || null; }
/** The nearest automation phase BEFORE `key` — the one a fill phase runs. */
function automationBefore(phases, key) {
    const list = Array.isArray(phases) ? phases : [];
    const i = list.findIndex((p) => p && p.key === key);
    for (let j = (i < 0 ? list.length : i) - 1; j >= 0; j--) if (kindOf(list[j]) === 'automation') return list[j];
    return null;
}

/** The app a phase governs: the nearest app phase before it that produced one. */
function appBefore(phases, key) {
    const list = Array.isArray(phases) ? phases : [];
    const i = list.findIndex((p) => p && p.key === key);
    for (let j = (i < 0 ? list.length : i) - 1; j >= 0; j--) {
        const p = list[j];
        if (p && (kindOf(p) === 'app' || kindOf(p) === 'app_turn') && p.artifacts && p.artifacts.appId) return p.artifacts.appId;
    }
    return null;
}

/**
 * A playbook that builds an app ends with ACCESS: who may open it, and with
 * which role. No recipe has to ask for it and no model writes it — it is the
 * last thing a person does before the app is somebody else's tool. Appended
 * once, after the last app phase, and never twice (a recipe document may
 * already carry one).
 */
function withClosingPhases(phases, copy) {
    const list = Array.isArray(phases) ? phases : [];
    if (!list.some((p) => kindOf(p) === 'app' || kindOf(p) === 'app_turn')) return list;
    const out = [...list];
    const used = new Set(out.map((p) => p.key));
    const add = (kind, label) => {
        if (out.some((p) => kindOf(p) === kind)) return;
        let key = kind;
        for (let n = 2; used.has(key); n++) key = `${kind}_${n}`;
        used.add(key);
        out.push({ key, kind, label, status: 'pending', attempt: 0, brief: null, artifacts: {}, summary: null, error: null });
    };
    // LAST, not straight after the app: an approval flow is built after the app
    // and belongs to the same tool. Access is the last thing a person DOES —
    // and the compliance review reads what access they just gave, so it comes
    // after it.
    add('access', copy.accessPhaseLabel);
    add('compliance', copy.compliancePhaseLabel);
    return out;
}

/** The list row the sidebar recents and the section list read. */
function summarise(pb, recipe) {
    const phases = Array.isArray(pb.phases) ? pb.phases : [];
    const done = phases.filter((p) => p.status === 'done' || p.status === 'skipped').length;
    return {
        id: pb.id,
        title: pb.title,
        recipeId: pb.recipeId,
        recipeLabel: recipe ? recipe.title : pb.recipeId,
        status: pb.status,
        currentPhase: pb.currentPhase,
        progress: { done, total: phases.length, locked: phases.filter((p) => p.status === 'locked').length },
        phases: phases.map((p) => ({ key: p.key, kind: kindOf(p), label: p.label || null, status: p.status })),
        updatedAt: pb.updatedAt,
        createdAt: pb.createdAt,
    };
}

module.exports = {
    localeOf,
    tierOf,
    kindOf,
    firstOfKind,
    automationBefore,
    appBefore,
    withClosingPhases,
    summarise,
};
