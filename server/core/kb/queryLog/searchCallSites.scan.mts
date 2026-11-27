/**
 * The scan behind searchCallSites.inventory.test.js: every non-test call of a knowledge search
 * function in the files it is given, as `file::name` pairs. A call is `name(` that is not the
 * function's own declaration; the HTTP route of the search service is matched as `tools/kb-search`.
 * The test hands it the files of every root of the tree, hidden modules included
 * (testUtils/serverTree.js): a call site in a module is still a call site.
 */

import { readFileSync } from 'node:fs';

export const SEARCH_FUNCTIONS = [
    'quickKBSearch', 'searchLocally', 'performKnowledgeSearch', 'executeKbSearchTool',
    'searchNotebookKB', 'searchWebpageKB', 'groundWithKB',
] as const;
export const SEARCH_ROUTE = 'tools/kb-search';

/** Directory names not scanned, at any depth. */
export const SKIP_DIRS = new Set(['node_modules', 'scripts', 'migrations', 'testUtils', 'coverage', 'dist', 'types', '.git']);
const isTestFile = (name: string): boolean => name.startsWith('searchCallSites.scan.') || /\.(test|testkit|spec)\.[cm]?[jt]s$/.test(name) || /\.test[-.]/.test(name);

/** Is a file of this name scanned (source, not a test)? */
export const keepFile = (name: string): boolean => /\.[cm]?[jt]s$/.test(name) && !isTestFile(name);

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

/** `file::name` for every call site in `files` (`rel` is the tree path). */
export function scanSearchCallSites(files: Iterable<{ rel: string; abs: string }>): string[] {
    const found = new Set<string>();
    const callRes = SEARCH_FUNCTIONS.map((name) => [name, new RegExp(`(?<!function\\s+)(?<![\\w$])${name}\\s*\\(`)] as const);
    for (const { rel, abs } of files) {
        for (const line of readFileSync(abs, 'utf8').split('\n')) {
            if (isComment(line)) continue;
            for (const [name, re] of callRes) if (re.test(line)) found.add(`${rel}::${name}`);
            if (line.includes(SEARCH_ROUTE)) found.add(`${rel}::${SEARCH_ROUTE}`);
        }
    }
    return [...found].sort();
}
