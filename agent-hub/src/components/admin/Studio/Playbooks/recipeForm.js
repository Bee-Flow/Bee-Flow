/**
 * What the New dialog reads from a recipe document — pure, shared with its test.
 */
export function inputsOf(recipe) {
    return Array.isArray(recipe?.inputs) ? recipe.inputs : [];
}
export function needsApprover(recipe) {
    return Array.isArray(recipe?.phases) && recipe.phases.some((p) => p.requires === 'approvals');
}
export function initialInputValues(recipe) {
    const out = {};
    for (const i of inputsOf(recipe)) out[i.key] = typeof i.default === 'string' ? i.default : '';
    return out;
}

