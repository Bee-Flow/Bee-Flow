/**
 * The scan behind searchCallSites.inventory.test.js: every non-test call of a knowledge search
 * function in the server tree, as `file::name` pairs. A call is `name(` that is not the
 * function's own declaration; the HTTP route of the search service is matched as `tools/kb-search`.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const SEARCH_FUNCTIONS = [
    'quickKBSearch', 'searchLocally', 'performKnowledgeSearch', 'executeKbSearchTool',
    'searchNotebookKB', 'searchWebpageKB', 'groundWithKB',
] as const;
export const SEARCH_ROUTE = 'tools/kb-search';

const SKIP_DIRS = new Set(['node_modules', 'scripts', 'migrations', 'testUtils', 'coverage', 'dist', 'types', '.git']);
const isTestFile = (name: string): boolean => name.startsWith('searchCallSites.scan.') || /\.(test|testkit|spec)\.[cm]?[jt]s$/.test(name) || /\.test[-.]/.test(name);

function* walk(dir: string): Generator<string> {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name)); continue; }
        if (/\.[cm]?[jt]s$/.test(e.name) && !isTestFile(e.name)) yield join(dir, e.name);
    }
}

const isComment = (line: string): boolean => /^\s*(\/\/|\*|\/\*)/.test(line);

/** `file::name` for every call site under `root` (the server directory). */
export function scanSearchCallSites(root: string): string[] {
    const found = new Set<string>();
    const callRes = SEARCH_FUNCTIONS.map((name) => [name, new RegExp(`(?<!function\\s+)(?<![\\w$])${name}\\s*\\(`)] as const);
    for (const file of walk(root)) {
        const rel = relative(root, file).split(sep).join('/');
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            if (isComment(line)) continue;
            for (const [name, re] of callRes) if (re.test(line)) found.add(`${rel}::${name}`);
            if (line.includes(SEARCH_ROUTE)) found.add(`${rel}::${SEARCH_ROUTE}`);
        }
    }
    return [...found].sort();
}
