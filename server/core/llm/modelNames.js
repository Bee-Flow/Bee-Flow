// @typecheck
/**
 * Display name → model id.
 *
 * Agents saved from the admin UI's model picker used to store the human
 * readable name ("GPT-4o Mini") rather than the id the API wants; this map
 * is how those records still resolve. An id-shaped value passes through
 * untouched.
 */

// Reverse lookup: display name → model ID (for agents saved with human-readable names)
const DISPLAY_NAME_TO_ID = {
    // Mistral models
    'Mistral Large 3': 'mistral-large-latest',
    'Mistral Medium 3.5': 'mistral-medium-latest',
    'Mistral Small 4': 'mistral-small-latest',
    'Ministral 3 14B': 'ministral-14b-latest',
    'Mistral Large 2.1': 'mistral-large-2411',
    'Mistral Medium 3.1': 'mistral-medium-latest',
    'Mistral Small 3.1': 'mistral-small-latest',
    'Mistral Small 3.2': 'mistral-small-latest',
    'Codestral': 'codestral-latest',
    'Devstral': 'devstral-latest',
    'Devstral Small': 'devstral-small-latest',
    'Ministral 3 3B': 'ministral-3b-latest',
    'Ministral 3 8B': 'ministral-8b-latest',
    'Ministral 14B': 'ministral-14b-latest',
    'Mistral Embed': 'mistral-embed',
    'Mistral OCR': 'mistral-ocr-latest',
    'Pixtral Large': 'pixtral-large-latest',
    'Magistral Small 1.2': 'magistral-small-latest',
    // OpenAI models
    'GPT-5.2': 'gpt-5.2',
    'GPT-5.2 Pro': 'gpt-5.2-pro',
    'GPT-5 Mini': 'gpt-5-mini',
    'GPT-4o': 'gpt-4o',
    'GPT-4o Mini': 'gpt-4o-mini',
    'GPT-4.1': 'gpt-4.1',
    'GPT-4.1 Mini': 'gpt-4.1-mini',
    'GPT-4.1 Nano': 'gpt-4.1-nano',
    'o3': 'o3',
    'o3 Mini': 'o3-mini',
    'o4 Mini': 'o4-mini',
    // Claude models — generated from the catalog, so a model cannot be
    // selectable in the admin UI while being absent from this map (which is
    // what happened to Claude Opus 5).
    ...Object.fromEntries(
        require('../providers/claudeModels')
            .listCatalogModels()
            .map((m) => [m.name, m.id]),
    ),
    // Google models
    'Gemini 3.1 Pro': 'gemini-3.1-pro-preview',
    'Gemini 3 Flash': 'gemini-3-flash-preview',
    'Gemini 3.1 Flash Image': 'gemini-3.1-flash-image-preview',
    'Gemini 3 Pro Image': 'gemini-3-pro-image-preview',
};

/**
 * Resolve a model identifier to a valid API model ID.
 * Handles display names, aliases, and already-valid IDs.
 */
function resolveModelId(modelNameOrId) {
    if (!modelNameOrId) return null;
    // If it's already a valid-looking model ID (alphanumeric with dashes/dots/underscores), return as-is
    if (/^[a-zA-Z0-9._-]+$/.test(modelNameOrId)) return modelNameOrId;
    // Try reverse lookup
    return DISPLAY_NAME_TO_ID[modelNameOrId] || modelNameOrId;
}

module.exports = { DISPLAY_NAME_TO_ID, resolveModelId };
