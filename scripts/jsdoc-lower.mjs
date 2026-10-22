// Lowers the inference edits of scripts/ts-callsite-types.mjs (TypeScript
// syntax: `x: T`, `interface P {...}`, `(e as Error)`, `import type`) to JSDoc,
// for a JavaScript file that stays JavaScript (the server: CommonJS, types
// from JSDoc, checked per file with `// @typecheck`).
//
//   param `x: T`            -> `@param {T} x` (optional: `[x]`) in the function's JSDoc
//   destructured `{a}: P`   -> `@param {P} param0`
//   `interface P { a?: T }` -> `@typedef {Object} P` + `@property {T} [a]`
//   `const x: T = ...`      -> `/** @type {T} */` above the statement
//   `(e as Error)`          -> `/** @type {Error} */ (e)` (a JSDoc cast)
//   `import type { X } from 's'` -> `/** @typedef {import('s').X} X */` at the top
//   `useState<T>`           -> dropped (no JSDoc form at the call)
//
// Only comments and the cast's parentheses are added: the program the file
// compiles to stays the same. An existing JSDoc block of the function gets the
// new tags before its closing line; a tag for a name it already documents is
// not added twice.

/** The JSDoc block (`/** ... *\/`) directly before position `at`, or null. */
function jsdocBefore(text, at) {
    const before = text.slice(0, at);
    const m = before.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/);
    if (!m) return null;
    const start = before.length - m[0].length;
    const end = start + m[0].replace(/\s*$/, '').length;
    return { start, end, body: m[0] };
}

const indentAt = (text, at) => { const ls = text.lastIndexOf('\n', at - 1) + 1; return text.slice(ls, at).match(/^[ \t]*/)[0]; };
const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;

/** `edits` (TypeScript-syntax inference edits on `text`) -> JSDoc edits on the same text. */
export function lowerToJsDoc(text, edits) {
    const out = []; const dropped = [];
    const byHost = new Map();
    const typedefs = [];
    for (const e of edits) {
        switch (e.kind) {
        case 'param': {
            if (!byHost.has(e.host)) byHost.set(e.host, []);
            const name = e.name || `param${e.index}`;
            byHost.get(e.host).push(`@param {${e.type}} ${e.optional ? `[${name}]` : name}`);
            break;
        }
        case 'interface': {
            const props = e.members.map((m) => ` * @property {${m.type}} ${m.optional ? `[${m.key}]` : m.key}`);
            typedefs.push({ at: e.start, lines: [`/**`, ` * @typedef {Object} ${e.name}`, ...props, ` */`] });
            break;
        }
        case 'var': {
            const ind = indentAt(text, e.host);
            out.push({ start: lineStart(text, e.host) + ind.length, end: lineStart(text, e.host) + ind.length, text: `/** @type {${e.type}} */\n${ind}` });
            break;
        }
        case 'castOpen': out.push({ start: e.start, end: e.start, text: `/** @type {${e.type}} */ (` }); break;
        case 'castClose': out.push({ start: e.start, end: e.start, text: ')' }); break;
        case 'imports': {
            const lines = e.imports.filter(([, spec]) => spec).map(([name, spec]) => `/** @typedef {import('${spec}').${name}} ${name} */`);
            if (lines.length) {
                // after a shebang, before everything else ('use strict' may follow a comment)
                const at = text.startsWith('#!') ? text.indexOf('\n') + 1 : 0;
                out.unshift({ start: at, end: at, text: `${lines.join('\n')}\n` }); // first of what goes at the top
            }
            break;
        }
        case 'arrowParen': break; // `x => ...` needs no parentheses for a JSDoc @param
        default: dropped.push(e.kind || 'unknown');
        }
    }
    for (const t of typedefs) {
        // Above the function's own JSDoc, which must stay right before the function.
        const own = jsdocBefore(text, t.at);
        const at = own ? own.start : t.at;
        const ind = indentAt(text, at);
        out.push({ start: at, end: at, text: `${t.lines.join(`\n${ind}`)}\n${ind}` });
    }
    for (const [host, tags] of byHost) {
        const ind = indentAt(text, host);
        const existing = jsdocBefore(text, host);
        if (existing) {
            const have = new Set([...existing.body.matchAll(/@param\s+(?:\{[^}]*\}\s*)?\[?([\w$.]+)/g)].map((m) => m[1]));
            const add = tags.filter((t) => !have.has(t.match(/\[?([\w$.]+)\]?$/)[1]));
            if (!add.length) continue;
            const close = existing.start + existing.body.lastIndexOf('*/');
            const single = !existing.body.slice(0, existing.body.lastIndexOf('*/')).includes('\n');
            if (single) {
                // `/** text */` -> a block with the text and the tags
                const inner = existing.body.slice(3, existing.body.lastIndexOf('*/')).trim();
                out.push({ start: existing.start, end: existing.end, text: `/**\n${ind} * ${inner}\n${add.map((a) => `${ind} * ${a}`).join('\n')}\n${ind} */` });
            } else {
                out.push({ start: lineStart(text, close), end: lineStart(text, close), text: add.map((a) => `${ind} * ${a}\n`).join('') });
            }
        } else {
            out.push({ start: host, end: host, text: `/**\n${tags.map((a) => `${ind} * ${a}`).join('\n')}\n${ind} */\n${ind}` });
        }
    }
    return { edits: out, dropped };
}
