/** One input a recipe asks for in the New dialog. */
export interface RecipeInput {
    key: string;
    default?: unknown;
    [extra: string]: unknown;
}

/** A phase as a recipe carries it. */
export interface RecipePhase {
    key?: string;
    kind?: string;
    label?: string;
    requires?: string;
    [extra: string]: unknown;
}

/** A recipe document, as far as the New dialog reads it. */
export interface RecipeLike {
    id?: string;
    inputs?: RecipeInput[];
    phases?: RecipePhase[];
    [extra: string]: unknown;
}

/**
 * What the New dialog reads from a recipe document — pure, shared with its test.
 */
export function inputsOf(recipe: RecipeLike | null | undefined): RecipeInput[] {
    return Array.isArray(recipe?.inputs) ? recipe.inputs : [];
}
export function needsApprover(recipe: RecipeLike | null | undefined): boolean {
    return Array.isArray(recipe?.phases) && recipe.phases.some((p: RecipePhase) => p.requires === 'approvals');
}
export function initialInputValues(recipe: RecipeLike | null | undefined): Record<string, string> {
    const out: Record<string, string> = {};
    for (const i of inputsOf(recipe)) out[i.key] = typeof i.default === 'string' ? i.default : '';
    return out;
}

