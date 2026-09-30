/**
 * The project form: what the create and edit sheets hold, and the body they
 * send to POST /api/projects and PUT /api/projects/:id
 * (server/routes/projects/schemas.js CreateBody / UpdateBody — closed
 * schemas, so a misspelled key would be a 400, not a silent ignore).
 *
 * Colours and icons are the web's own palettes (ProjectDetailPage.jsx
 * COLORS / ICONS), so a project made on the phone looks the same on the web.
 */

/** The limits routes/projects/schemas.js enforces, repeated for instant feedback. */
export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 1000;
export const INSTRUCTIONS_MAX = 8000;

export const PROJECT_COLORS: readonly string[] = [
    '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e', '#f97316',
    '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6',
];

export const PROJECT_ICONS: readonly string[] = [
    '📦', '📁', '🚀', '💡', '🎯', '📊', '🔬', '🎨', '📝', '🏗️', '⚡', '🌟', '🔧',
];

export interface ProjectDraft extends Record<string, unknown> {
    name: string;
    description: string;
    customInstructions: string;
    icon: string;
    color: string;
}

/** A new Solution: the icon the web's "New Solution" gives one. */
export const EMPTY_DRAFT: ProjectDraft = {
    name: '',
    description: '',
    customInstructions: '',
    icon: '📦',
    color: '#6366f1',
};

export function draftFrom(project: {
    name: string;
    description: string | null;
    customInstructions: string | null;
    icon: string | null;
    color: string | null;
}): ProjectDraft {
    return {
        name: project.name,
        description: project.description ?? '',
        customInstructions: project.customInstructions ?? '',
        icon: project.icon || EMPTY_DRAFT.icon,
        color: project.color || EMPTY_DRAFT.color,
    };
}

export interface ProjectBody {
    name: string;
    description: string | null;
    customInstructions: string | null;
    icon: string;
    color: string;
    /** The version the editor loaded: a stale save is a 409, not a silent overwrite. */
    version?: number;
}

/** The request body. Blank text is sent as null ("none"), never as "". */
export function bodyFrom(draft: ProjectDraft, version?: number): ProjectBody {
    const orNull = (v: string) => (v.trim() ? v : null);
    return {
        name: draft.name.trim(),
        description: orNull(draft.description),
        customInstructions: orNull(draft.customInstructions),
        icon: draft.icon,
        color: draft.color,
        ...(version === undefined ? {} : { version }),
    };
}
