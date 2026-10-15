/**
 * What the New dialog reads from a recipe document — pure, shared with its test.
 */
import type { Recipe, RecipeInput } from './playbookTypes';

export function inputsOf(recipe: Recipe | null | undefined): RecipeInput[] {
    return Array.isArray(recipe?.inputs) ? recipe.inputs : [];
}
export function needsApprover(recipe: Recipe | null | undefined): boolean {
    return Array.isArray(recipe?.phases) && recipe.phases.some((p) => p.requires === 'approvals');
}
export function initialInputValues(recipe: Recipe | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of inputsOf(recipe)) out[i.key] = typeof i.default === 'string' ? i.default : '';
    return out;
}

