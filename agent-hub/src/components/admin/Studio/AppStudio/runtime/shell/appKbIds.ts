/**
 * The knowledge bases an app definition reads: the `knowledgeBaseIds` of its
 * kb_query / ai_generate / ai_extract steps, wherever they sit in the
 * actions. An `ai_chat` component is skipped because it draws its own
 * notice next to its input.
 */
export function appKbIds(definition: unknown): string[] {
    const found = new Set<string>();
    const walk = (node: unknown, depth: number): void => {
        if (!node || typeof node !== 'object' || depth > 40) return;
        if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
        const obj = node as Record<string, unknown>;
        if (obj.type === 'ai_chat') return;
        const ids = obj.knowledgeBaseIds;
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && id) found.add(id);
        for (const value of Object.values(obj)) walk(value, depth + 1);
    };
    walk(definition, 0);
    return [...found].sort();
}
