/**
 * Test-only: lift a function (or a `const X = …;` statement) out of a source
 * file's TEXT and run it, for originals that cannot be required as a whole
 * (a React hook module, a server module whose imports need a database).
 *
 * Only for plain-JavaScript bodies without imports of their own; anything the
 * body references is passed in as a named dependency.
 *
 * Never imported by app code.
 */

/** The source of `function name(…) { … }`, matched by braces. Throws when absent. */
export function functionSource(src: string, name: string): string {
    const start = src.search(new RegExp(`(^|\\n)(export )?function ${name}\\(`));
    if (start < 0) throw new Error(`function ${name} not found`);
    const open = src.indexOf('{', src.indexOf(')', start));
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        if (depth === 0) return src.slice(start, i + 1).trim().replace(/^export /, '');
    }
    throw new Error(`function ${name} is not closed`);
}

/** The source of a one-statement `const name = …;` declaration. Throws when absent. */
export function constSource(src: string, name: string): string {
    const m = new RegExp(`(?:export )?const ${name}\\s*=[\\s\\S]*?;\\n`).exec(src);
    if (!m) throw new Error(`const ${name} not found`);
    return m[0].replace(/^export /, '');
}

/**
 * Evaluate the given declarations and return the named bindings.
 * `deps` are in scope for the bodies (e.g. { tryEvaluate }).
 */
export function evalSource<T>(sources: string[], names: string[], deps: Record<string, unknown> = {}): T {
    // nosemgrep: ajinabraham.njsscan.eval.eval_node.eval_nodejs -- test-only helper, imported only by *.lockstep.test.ts files, that runs functions lifted from this repo's own source text
    const body = `${sources.join('\n')}\nreturn { ${names.join(', ')} };`;
    const factory = new Function(...Object.keys(deps), body) as (...args: unknown[]) => T;
    return factory(...Object.values(deps));
}
