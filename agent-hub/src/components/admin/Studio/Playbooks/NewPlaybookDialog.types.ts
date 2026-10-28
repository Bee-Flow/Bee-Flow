import type { RecipeInput, RecipePhase } from './recipeForm';
import type { PermissionUser } from '@/hooks/usePermissionCheck';
import type { PlaybookListItem } from './PlaybookCard';
import type { TranslateFn } from '@/hooks/useTranslation';

/**
 * Start a playbook. Two doors: a built-in recipe (the server lists them as
 * documents), or DESCRIBE IT — a few sentences the Fast model turns into a
 * recipe document (phases, table columns, inputs) that is previewed here
 * before anything is created. The form below the recipe is generic: it
 * reads the document — its inputs (a Nextcloud folder, a text), whether
 * there is a table (new or existing), whether a phase needs an approver.
 */
/** One input of a recipe, with the words the form prints. */
export type NewRecipeInput = RecipeInput & { label?: string; kind?: string; placeholder?: string };

/** A recipe document: the server's, the AI's, or the static fallback. */
export type RecipeDoc = {
    id: string;
    title?: string;
    description?: string;
    labelKey?: string;
    labelFallback?: string;
    blurbKey?: string;
    blurbFallback?: string;
    source?: string;
    warnings?: string[];
    table?: { fields?: Array<{ key: string; name?: string; type?: string }> };
    inputs?: NewRecipeInput[];
    phases?: RecipePhase[];
    [extra: string]: unknown;
};

/** The built-in recipes' client half (recipes.ts), as the picker reads it. */
export interface StaticRecipe {
    id: string;
    labelKey: string;
    labelFallback: string;
    blurbKey: string;
    blurbFallback: string;
    defaults: { folderPath: string };
    phases: string[];
}

/** A refusal from the playbooks API: the server's code and body ride on the Error. */
export interface ApiError extends Error {
    code?: string;
    body: { errors: Array<{ message?: string }> };
}

export interface NewPlaybookDialogProps {
    user?: PermissionUser | null;
    onClose: () => void;
    onCreated?: ((playbook: PlaybookListItem) => void) | null;
    hasLicenseFeature?: (feature: string) => boolean;
}

/** What the AI wrote: the phases in order, the table's columns, the inputs. */
export interface RecipePreviewProps {
    recipe: RecipeDoc;
    warnings?: string[];
    t: TranslateFn;
}
