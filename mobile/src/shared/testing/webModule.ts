/**
 * Run a pure agent-hub module inside a mobile test, for a differential
 * lockstep test (ARCHITECTURE "Sharing logic with the web app").
 *
 * A plain `require` works only for a web file with no imports: Babel turns an
 * import into a call to an `@babel/runtime` helper resolved from agent-hub's
 * own node_modules, which the mobile job does not install. So the source is
 * read as text, its `import` lines are dropped, its `export` keywords are
 * stripped, and the named dependencies are handed in by the test — the web's
 * own implementation of each, loaded the same way, wherever that matters.
 *
 * Test-only; nothing in the app imports this.
 */

import fs from 'node:fs';

/** The web tree, resolved from mobile/src/shared/testing. */
export const AGENT_HUB_SRC = `${__dirname}/../../../../agent-hub/src`;

export function webFileExists(relative: string): boolean {
    return fs.existsSync(`${AGENT_HUB_SRC}/${relative}`);
}

/** The source text of one top-level `function name(…) {…}`, braces matched. */
export function functionSource(src: string, name: string): string {
    const start = src.search(new RegExp(`^(?:export )?function ${name}\\(`, 'm'));
    if (start < 0) throw new Error(`function ${name} not found`);
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1).replace(/^export /, '');
    }
    throw new Error(`function ${name} is not closed`);
}

/**
 * Only some pure functions out of a web file that as a whole cannot run here
 * (one with JSX in it, say): each named function's own source, evaluated with
 * `deps` in scope.
 */
export function loadWebFunctions<T = Record<string, unknown>>(
    relative: string,
    names: readonly string[],
    deps: Record<string, unknown> = {},
): T {
    const src = fs.readFileSync(`${AGENT_HUB_SRC}/${relative}`, 'utf8');
    const body = `${names.map((n) => functionSource(src, n)).join('\n')}\nreturn { ${names.join(', ')} };`;
    return new Function(...Object.keys(deps), body)(...Object.values(deps)) as T;
}

const IMPORT_RX = /^import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?[ \t]*$/gm;
const DECLARED_EXPORT_RX = /^export\s+(?:default\s+)?((?:async\s+)?(?:function\*?|const|let|class))\s+([A-Za-z0-9_$]+)/gm;
const LIST_EXPORT_RX = /^export\s*\{([^}]*)\};?[ \t]*$/gm;

/** A path under agent-hub/src, or an absolute one (a caller that resolved it itself). */
const resolveWeb = (file: string) => (file.startsWith('/') ? file : `${AGENT_HUB_SRC}/${file}`);

/**
 * Evaluate a web module's source with `deps` in scope; answers its named
 * exports — declared ones (`export function x`, `export async function`,
 * `export const`, `export class`) and listed ones (`export { a, b as c }`).
 * A trailing `export default name;` is dropped: the name is declared anyway.
 */
export function loadWebModule<T = Record<string, unknown>>(file: string, deps: Record<string, unknown> = {}): T {
    const names = new Set<string>();
    const body = fs
        .readFileSync(resolveWeb(file), 'utf8')
        .replace(IMPORT_RX, '')
        .replace(/^export \* from .*$/gm, '')
        .replace(/^export default [A-Za-z0-9_$]+;?[ \t]*$/gm, '')
        .replace(DECLARED_EXPORT_RX, (_m, kind: string, name: string) => {
            names.add(name);
            return `${kind} ${name}`;
        })
        .replace(LIST_EXPORT_RX, (_m, list: string) => {
            for (const part of list.split(',')) {
                const name = part.trim().split(/\s+as\s+/).pop();
                if (name) names.add(name);
            }
            return '';
        });
    const depNames = Object.keys(deps);
    const factory = new Function(...depNames, `'use strict';\n${body}\nreturn { ${[...names].join(', ')} };`);
    return factory(...depNames.map((name) => deps[name])) as T;
}
