/**
 * The recipes the New dialog offers. The server owns the recipe (its phases,
 * schema and briefs — server/playbooks/recipes); this is the client's copy of
 * what the picker needs: id, label/blurb keys, phase keys for the preview and
 * the option defaults. One today; the dialog is keyed on `id` so a second
 * recipe is one entry here plus its options form.
 */
/**
 * The built-in recipes the New dialog offers — EMPTY since 2026-09-16 (owner):
 * a playbook is described in your own words and the AI writes the phases. The
 * dialog still renders whatever `GET /api/playbooks/recipes` returns, so
 * putting one back on the server is enough to see it here again.
 */
export const RECIPES = Object.freeze([]);

// Keyed by the built-in recipe's keys AND by kind (a custom playbook's
// phases carry their own `label`; the kind word is the fallback).
export const PHASE_LABEL_KEYS = Object.freeze({
    table: ['playbooks.phase.table', 'Table'],
    routine: ['playbooks.phase.routine', 'Automation'],
    fill: ['playbooks.phase.fill', 'First rows'],
    design: ['playbooks.phase.design', 'Design'],
    app: ['playbooks.phase.app', 'App'],
    approvals: ['playbooks.phase.approvals', 'Approval flow'],
    app_turn: ['playbooks.phase.app_turn', 'App, next turn'],
    access: ['playbooks.phase.access', 'Access'],
    compliance: ['playbooks.phase.compliance', 'Compliance check'],
});

/**
 * What a phase LOOKS like — the kind whose colour and glyph it borrows.
 *
 * There was no registry, so every stage hand-rolled its own 40px tile at its own
 * tint in its own colour, and three had no tile at all. `kindTileStyle` exists
 * precisely so a kind cannot be blue on the rail and teal on the stage.
 *
 * `design` reads as `app` (it is a drawing OF an app; it used to be AI-blue,
 * although `--kind-app` was already its own accent fallback), and `access`
 * likewise — it governs the app, it is not a phase of its own colour.
 */
export const PHASE_VISUAL = Object.freeze({
    table: 'datatable',
    routine: 'automation',
    fill: 'datatable',
    design: 'app',
    app: 'app',
    app_turn: 'app',
    approvals: 'automation',
    access: 'app',
    compliance: 'compliance',
});

/** The kind key a phase borrows its colour and glyph from. */
export function phaseKind(phase) {
    if (!phase) return 'playbook';
    return PHASE_VISUAL[phase.kind] || PHASE_VISUAL[phase.key] || 'playbook';
}

/** The words for a phase: its own label (a custom recipe), else the kind's. */
export function phaseLabel(phase, t) {
    if (!phase) return '';
    if (phase.label) return phase.label;
    const hit = PHASE_LABEL_KEYS[phase.key] || PHASE_LABEL_KEYS[phase.kind];
    return hit ? t(hit[0], hit[1]) : (phase.key || '');
}

export function recipeById(id) {
    return RECIPES.find((r) => r.id === id) || null;
}
