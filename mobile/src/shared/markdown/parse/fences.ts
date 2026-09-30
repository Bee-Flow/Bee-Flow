/**
 * Fenced code blocks, and which of them the web draws as something other than
 * code.
 *
 * The web's CodeRenderer (agent-hub/src/components/renderers/
 * MarkdownRenderer.jsx) tests the fence's language against a fixed set of
 * names per renderer; FENCE_LANGUAGES is that table, and fences.lockstep.test.ts
 * fails when the web gains or drops a name.
 */

export type FenceKind = 'code' | 'workspace' | 'page' | 'research' | 'test-report' | 'vega-lite' | 'mermaid' | 'map';

/** The web's language names per rich renderer, in the order CodeRenderer tests them. */
export const FENCE_LANGUAGES: Readonly<Record<Exclude<FenceKind, 'code'>, readonly string[]>> = {
    workspace: ['workspace', 'workspace-selection'],
    page: ['json-page', 'page', 'page-json'],
    research: ['json-research', 'research', 'research-json'],
    'test-report': ['json-test-report', 'test-report', 'test-report-json'],
    'vega-lite': ['vega-lite', 'vegalite', 'vega'],
    mermaid: ['mermaid'],
    map: ['map-embed', 'map', 'maps'],
};

const KIND_BY_LANGUAGE = new Map<string, FenceKind>(
    Object.entries(FENCE_LANGUAGES).flatMap(([kind, names]) => names.map((name) => [name, kind as FenceKind] as const)),
);

/**
 * The language of a fence, as the web reads it: react-markdown puts the info
 * string's first word into `language-<word>`, and the web's pattern then
 * keeps `[\w-]+` of it (so ```c++ is "c").
 */
export function fenceLanguage(info: string | undefined): string {
    const word = (info ?? '').trim().split(/\s/, 1)[0] ?? '';
    return /^[\w-]+/.exec(word)?.[0] ?? '';
}

export function fenceKind(language: string): FenceKind {
    return KIND_BY_LANGUAGE.get(language) ?? 'code';
}

/** The JSON-bodied kinds: incomplete JSON means "still arriving" on the web. */
export const JSON_KINDS: ReadonlySet<FenceKind> = new Set(['page', 'research', 'test-report', 'vega-lite', 'map']);

/**
 * Whether a fenced block's source has its closing fence. marked (like
 * CommonMark) runs an unclosed fence to the end of the answer, which is
 * exactly what a streaming answer looks like mid-block. An indented code
 * block has no fence and is always complete.
 */
export function isClosedFence(raw: string): boolean {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (!open) return true;
    const fence = open[1] as string;
    const lines = raw.trimEnd().split('\n');
    if (lines.length < 2) return false;
    const last = (lines[lines.length - 1] as string).trim();
    return last.length >= fence.length && last.split('').every((c) => c === fence[0]);
}
