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
//   `import type { X } from 's'` -> `/** @typedef {import('s').X} X */` at the top;
//                              a generic X (`X<string>`) is written inline as
//                              `import('s').X<string>` (an alias would drop the parameter)
//   `useState<T>`           -> dropped (no JSDoc form at the call)
//
// Only comments and the cast's parentheses are added: the program the file
// compiles to stays the same. An existing JSDoc block of the function gets the
// new tags before its closing line; a tag for a name it already documents is
// not added twice, nor is a tag for a destructured parameter that the block
// already documents by position (`@param {object} args` + `args.x`: TypeScript
// matches a binding pattern to the n-th tag, a second tag would be TS8024).
// A typedef or typedef import the text already holds is not added again.

import { jsdocTypedefNames } from './ts-callsite-types.mjs';

/** The JSDoc block (`/** ... *\/`) directly before position `at`, or null. */
function jsdocBefore(text, at) {
    const before = text.slice(0, at);
    const m = before.match(/\/\*\*(?:(?!\*\/)[\s\S])*\*\/\s*$/);
    if (!m) return null;
    const start = before.length - m[0].length;
    const end = start + m[0].replace(/\s*$/, '').length;
    return { start, end, body: m[0] };
}

/** The `@param` tags of a JSDoc body, in order: [{ name, top }] (`top`: not an `args.x` member), braces balanced. */
export function paramTags(body) {
    const out = [];
    const re = /@param\s+/g; let m;
    while ((m = re.exec(body))) {
        let i = m.index + m[0].length;
        if (body[i] === '{') {
            let depth = 0;
            for (; i < body.length; i++) { if (body[i] === '{') depth++; else if (body[i] === '}') { depth--; if (!depth) { i++; break; } } }
            while (i < body.length && /\s/.test(body[i])) i++;
        }
        if (body[i] === '[') i++;
        const n = /^[\w$.]+/.exec(body.slice(i));
        if (n) out.push({ name: n[0], top: !n[0].includes('.') });
    }
    return out;
}

const indentAt = (text, at) => { const ls = text.lastIndexOf('\n', at - 1) + 1; return text.slice(ls, at).match(/^[ \t]*/)[0]; };
const lineStart = (text, at) => text.lastIndexOf('\n', at - 1) + 1;

/** `edits` (TypeScript-syntax inference edits on `text`) -> JSDoc edits on the same text. */
export function lowerToJsDoc(text, edits) {
    const out = []; const dropped = [];
    const byHost = new Map();
    const typedefs = [];
    const haveTypedefs = jsdocTypedefNames(text);
    // Generic imported types are written inline wherever they appear.
    const generic = new Map();
    for (const e of edits) if (e.kind === 'imports') for (const [name, spec, g] of e.imports) if (g && spec) generic.set(name, spec);
    const sub = (t) => { let s = t; for (const [name, spec] of generic) s = s.replace(new RegExp(`(^|[^\\w$.])${name}(?=<)`, 'g'), `$1import('${spec}').${name}`); return s; };
    for (const e of edits) {
        switch (e.kind) {
        case 'param': {
            if (!byHost.has(e.host)) byHost.set(e.host, []);
            const name = e.name || `param${e.index}`;
            byHost.get(e.host).push({ text: `@param {${sub(e.type)}} ${e.optional ? `[${name}]` : name}`, name, index: e.index, positional: !e.name });
            break;
        }
        case 'interface': {
            if (haveTypedefs.has(e.name)) break;
            const props = e.members.map((m) => ` * @property {${sub(m.type)}} ${m.optional ? `[${m.key}]` : m.key}`);
            typedefs.push({ at: e.start, lines: [`/**`, ` * @typedef {Object} ${e.name}`, ...props, ` */`] });
            break;
        }
        case 'var': {
            const ind = indentAt(text, e.host);
            const ls = lineStart(text, e.host);
            // A statement that opens its line gets the comment on the line above.
            // One in the middle of a line (`{ let x = null; ... }`) gets it after
            // the keyword: `let /** @type {T} */ x`. TypeScript binds a JSDoc on
            // the same line as the previous token to the declaration only there
            // (a comment before `let` is the `{`'s trailing comment, and ignored).
            const kw = /^(let|const|var)\s+/.exec(text.slice(e.host));
            if (/^\s*$/.test(text.slice(ls, e.host))) out.push({ start: ls + ind.length, end: ls + ind.length, text: `/** @type {${sub(e.type)}} */\n${ind}` });
            else if (kw) out.push({ start: e.host + kw[0].length, end: e.host + kw[0].length, text: `/** @type {${sub(e.type)}} */ ` });
            else dropped.push('var (mid-line, no keyword)');
            break;
        }
        case 'castOpen': out.push({ start: e.start, end: e.start, text: `/** @type {${sub(e.type)}} */ (` }); break;
        case 'castClose': out.push({ start: e.start, end: e.start, text: ')' }); break;
        case 'imports': {
            const lines = e.imports.filter(([name, spec, g]) => spec && !g && !haveTypedefs.has(name)).map(([name, spec]) => `/** @typedef {import('${spec}').${name}} ${name} */`);
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
            const known = paramTags(existing.body);
            const have = new Set(known.map((k) => k.name));
            const top = known.filter((k) => k.top).length;
            const add = tags.filter((t) => !have.has(t.name) && !(t.positional && top > t.index)).map((t) => t.text);
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
            out.push({ start: host, end: host, text: `/**\n${tags.map((a) => `${ind} * ${a.text}`).join('\n')}\n${ind} */\n${ind}` });
        }
    }
    return { edits: out, dropped };
}
