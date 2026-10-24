/**
 * The pure rules of MarkdownRenderer, kept in a leaf module (no imports) so the
 * phone can run the very same patterns: mobile/src/shared/markdown/mirror/
 * markdownRules.ts is a generated copy (scripts/shared-mirror.manifest.json,
 * `npm run gen:shared`). Edit this file, never the copy.
 */

/** An opening ```markdown / ```md / ```text / ``` fence at the very start of an answer. */
export const WRAPPING_FENCE_OPEN = /^\s*```(?:markdown|md|text)?\n/i;
/** A closing fence at the very end. */
export const WRAPPING_FENCE_CLOSE = /\n```\s*$/;
/** `:::writing Title` and its siblings (newer GPT models), which become `## Title`. */
export const DIRECTIVE_OPEN = /^:::(writing|note|tip|warning|important|caution)[\t ]+(.+)$/gm;
/** A bare `:::` closing line, which is dropped. */
export const DIRECTIVE_CLOSE = /^:::[\t ]*$/gm;

/** `:::writing Title` → `## Title`; a lone `:::` line → nothing. */
export function stripDirectiveBlocks(text: string): string {
    if (typeof text !== 'string') return text;
    return text.replace(DIRECTIVE_OPEN, '## $2').replace(DIRECTIVE_CLOSE, '');
}

/** Links the web draws as a card instead of an anchor. */
export const WEBPAGE_CARD = /^\/app\/(?:studio\/)?webpages\/[a-zA-Z0-9_-]+$/;
export const DOCUMENT_CARD = /^\/app\/studio\/documents\/[a-zA-Z0-9_-]+$/;

/** The id a heading gets: lower case, letters/digits/spaces/hyphens kept, spaces to hyphens. */
export function headingSlug(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

/** The fuzzy form of a `#fragment` or a heading's text: `[a-z0-9]` only. */
export function anchorKey(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Pretty language labels in a code block's header. */
export const LANG_LABELS: Record<string, string> = {
    python: 'Python', py: 'Python', javascript: 'JavaScript', js: 'JavaScript',
    typescript: 'TypeScript', ts: 'TypeScript', jsx: 'JSX', tsx: 'TSX',
    html: 'HTML', css: 'CSS', json: 'JSON', bash: 'Bash', sh: 'Shell',
    sql: 'SQL', yaml: 'YAML', yml: 'YAML', markdown: 'Markdown', md: 'Markdown',
    java: 'Java', cpp: 'C++', c: 'C', rust: 'Rust', go: 'Go', ruby: 'Ruby',
    php: 'PHP', swift: 'Swift', kotlin: 'Kotlin', r: 'R', lua: 'Lua',
    xml: 'XML', csv: 'CSV', toml: 'TOML', ini: 'INI', dockerfile: 'Dockerfile',
};
