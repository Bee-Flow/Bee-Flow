/**
 * The scan behind searchCallSites.inventory.test.js: every non-test call of a knowledge search
 * function in the server tree, as `file::name` pairs. A call is `name(` that is not the
 * function's own declaration; the HTTP route of the search service is matched as `tools/kb-search`.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// Over every root of the tree (moduleRoots.cjs): a call site in a module is still a call site.
const { walkTreeFiles } = createRequire(import.meta.url)('../../../utils/treeDir.js') as {
    walkTreeFiles: (dir: string, filters: { skipDir: (name: string) => boolean; keepFile: (name: string) => boolean }) => Iterable<{ rel: string; abs: string }>;
};

export const SEARCH_FUNCTIONS = [
    'quickKBSearch', 'searchLocally', 'performKnowledgeSearch', 'executeKbSearchTool',
    'searchNotebookKB', 'searchWebpageKB', 'groundWithKB',
] as const;
export const SEARCH_ROUTE = 'tools/kb-search';

const SKIP_DIRS = new Set(['node_modules', 'scripts', 'migrations', 'testUtils', 'coverage', 'dist', 'types', '.git']);
const isTestFile = (name: string): boolean => name.startsWith('searchCallSites.scan.') || /\.(test|testkit|spec)\.[cm]?[jt]s$/.test(name) || /\.test[-.]/.test(name);

const walk = (dir: string): Iterable<{ rel: string; abs: string }> => walkTreeFiles(dir, {
    skipDir: (name) => SKIP_DIRS.has(name),
    keepFile: (name) => /\.[cm]?[jt]s$/.test(name) && !isTestFile(name),
});

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

/** `file::name` for every call site under `root` (the server directory, over every root of the tree). */
export function scanSearchCallSites(root: string): string[] {
    const found = new Set<string>();
    const callRes = SEARCH_FUNCTIONS.map((name) => [name, new RegExp(`(?<!function\\s+)(?<![\\w$])${name}\\s*\\(`)] as const);
    for (const { rel, abs } of walk(root)) {
        for (const line of readFileSync(abs, 'utf8').split('\n')) {
            if (isComment(line)) continue;
            for (const [name, re] of callRes) if (re.test(line)) found.add(`${rel}::${name}`);
            if (line.includes(SEARCH_ROUTE)) found.add(`${rel}::${SEARCH_ROUTE}`);
        }
    }
    return [...found].sort();
}
