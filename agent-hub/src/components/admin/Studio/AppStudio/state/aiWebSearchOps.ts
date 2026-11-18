import type { AppDefinition } from '../inspector/appDefinition';

/**
 * Web search for the app's AI steps on or off (server: definitionKeys/aiWebSearch.js).
 *
 * The owner's switch, like aiBrowsing: the builder tools cannot write it, because a search query
 * can carry the app's data to the search service. Off REMOVES the key, so an app that never
 * searched canonicalizes exactly as before.
 */
export function updateAiWebSearch(def: AppDefinition, enabled: boolean): AppDefinition {
    if (!enabled) {
        if (!('aiWebSearch' in def)) return def;
        const { aiWebSearch: _dropped, ...rest } = def;
        return rest;
    }
    if (def.aiWebSearch?.enabled === true) return def;
    return { ...def, aiWebSearch: { enabled: true } };
}
