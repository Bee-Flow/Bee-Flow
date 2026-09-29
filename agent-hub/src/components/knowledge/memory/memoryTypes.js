/**
 * The memory type vocabulary, and one place to turn a type id into a label.
 *
 * There were two hardcoded English maps — one in `pages/settings/MemorySection`
 * and one in `MemoryPanel` — and they had already drifted ("Instructions" vs
 * "Instruction"). Neither went through i18n, so the chips on the Memory screen
 * stayed English in every locale, and a type added on the server rendered as a
 * raw key like `context`.
 *
 * Mirrors `MEMORY_TYPES` in `server/routes/memory.js`, which is the source of
 * truth: the API validates against it and the extractor's JSON schema enumerates
 * it. `routine_coverage` is deliberately absent from both — it is internal
 * bookkeeping and is filtered out before anything user-facing.
 */

export const MEMORY_TYPE_IDS = [
    'instruction',
    'person',
    'project',
    'preference',
    'workflow',
    'fact',
    'context',
];

/**
 * Translated plural label for a memory type.
 * Falls back to the raw id so an unknown type degrades to something readable
 * rather than to `undefined`.
 *
 * @param {(key: string, fallback?: string) => string} t
 * @param {string} id
 */
export function typeLabel(t, id) {
    const fallbacks = {
        instruction: 'Instructions',
        person: 'People',
        project: 'Projects',
        preference: 'Preferences',
        workflow: 'Workflows',
        fact: 'Facts',
        context: 'Context',
    };
    if (!fallbacks[id]) return id;
    return t(`settings.memory_type_${id}`, fallbacks[id]);
}
