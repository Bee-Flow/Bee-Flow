#!/usr/bin/env node
// Moves top-level declarations of a file into a sibling file, with the old file
// still working for every importer.
//
//   node scripts/ts-split.mjs <file> --move A,B,C --to <sibling path> [--dry] [--rewrite-importers] [--preview] [--closure]
//
// - The declarations move with their leading JSDoc / comment lines.
// - The sibling gets the imports the moved code needs (relative specifiers are
//   re-based) and exports what the old file needs back.
// - The old file imports the moved names it still uses and keeps exporting the
//   ones it exported:
//     ESM / TS   import { A } from './sibling'; export { A } from './sibling';
//     CommonJS   const { A, B } = require('./sibling');  (the file's own
//                module.exports / exports.X lines stay as they are and now point
//                at the imported bindings, so every key survives)
// - Refused (exit 2) when a moved declaration references a declaration that stays
//   (the sibling would import back), unless that one is listed too. Also refused: a
//   `let`/`var` that staying code uses (an import is a copy / read-only), a default
//   export, an import binding, a missing name, an existing sibling.
// - --closure grows --move to the smallest closed set that contains the given names:
//   every declaration they reference, transitively (the dependsOn a refusal would list),
//   so one call replaces the add-and-retry loop. Reported under `closure`
//   ({ requested, added }). A let/var that staying code uses, a default export and
//   the like are still refused.
// - A name inside a multi-name declaration (`const { a, b } = x;`, `const a = 1, b = 2;`)
//   splits that declaration into one const per name first (same behaviour; listed under
//   `splitDeclarations`), or moves the whole declaration when all its names are listed.
//   A destructuring whose initializer is not a plain identifier / member chain / require('x')
//   (a call would run twice), a rest element and an array pattern are refused: list all names.
// - Test coupling that a move breaks silently is warned about (and listed under
//   `testCouplings`): a test that stubs by the REQUIRING file's path
//   (`Module._resolveFilename` checking `parent.filename`, `require.cache[...]` keyed on a
//   path) or reads the file as text (`readFileSync` of its path).
// - --rewrite-importers (agent-hub only) points importers at the sibling. vi.mock /
//   jest.mock / require.cache references to the old file are never rewritten; they
//   are listed under mockReferences.
//
// Prints JSON: { moved, refused, created, touched, mockReferences, warnings, ... }.
// Shares its parser with ts-outline.mjs (TypeScript 6 JS API).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyze, findTests, loadTs, mockRefs, packageRoot, SOURCE_FILE_RE, specIsFile, testCouplings, walk } from './ts-outline.mjs';
import { readAliases } from './scc-ratchet.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = (p) => p.split(path.sep).join('/');
const shown = (p) => (p.startsWith(`${ROOT}${path.sep}`) ? path.relative(ROOT, p) : p);

/** Specifier for `target` written in a file in `fromDir`; ts/tsx/js lose their extension unless `ext` says otherwise. */
function relSpec(fromDir, target, ext) {
    let t = target;
    if (ext === 'js') t = t.replace(/\.[cm]?tsx?$/, (m) => (m.startsWith('.m') ? '.mjs' : m.startsWith('.c') ? '.cjs' : '.js'));
    else if (!/\.[cm]js$/.test(t)) t = t.replace(/\.(?:tsx?|jsx?)$/, '');
    let r = posix(path.relative(fromDir, t));
    if (!r.startsWith('.')) r = `./${r}`;
    return r;
}

/** Do this file's relative imports spell `.js` extensions (NodeNext style)? */
function usesJsExt(a) {
    return a.importStmts.some((s) => s.spec.startsWith('.') && /\.js$/.test(s.spec)) && /\.[cm]?tsx?$/.test(a.file);
}

const quoteOf = (s) => (s.specNode.getText().startsWith('"') ? '"' : "'");

/** One import statement for a subset of a statement's bindings, with `spec`. */
function renderImport(stmt, used, spec) {
    const q = quoteOf(stmt);
    if (!stmt.esm) {
        const kw = stmt.declKeyword;
        if (used[0].kind === 'cjs-whole') return `${kw} ${used[0].local} = require(${q}${spec}${q})${stmt.suffix || ''};`;
        return `${kw} { ${used.map((b) => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`)).join(', ')} } = require(${q}${spec}${q});`;
    }
    const def = used.find((b) => b.kind === 'default');
    const ns = used.find((b) => b.kind === 'ns');
    const named = used.filter((b) => b.kind === 'named');
    const parts = [def?.local, ns ? `* as ${ns.local}` : null,
        named.length ? `{ ${named.map((b) => `${b.typeOnly && !stmt.typeOnly ? 'type ' : ''}${b.imported === b.local ? b.local : `${b.imported} as ${b.local}`}`).join(', ')} }` : null].filter(Boolean);
    return `import ${stmt.typeOnly ? 'type ' : ''}${parts.join(', ')} from ${q}${spec}${q};`;
}

const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
function lineEndIncl(t, i) { const n = t.indexOf('\n', i); return n === -1 ? t.length : n + 1; }

/** Whole-line ranges to delete; neighbours separated by blank lines merge, and a blank line is not left doubled. */
function mergeRemovals(text, ranges) {
    const sorted = ranges.map(([x, y]) => [lineStart(text, x), lineEndIncl(text, y)]).sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const r of sorted) {
        const last = merged[merged.length - 1];
        if (last && /^\s*$/.test(text.slice(last[1], r[0]))) last[1] = Math.max(last[1], r[1]); else merged.push([...r]);
    }
    for (const r of merged) {
        const blankBefore = r[0] === 0 || text.slice(Math.max(0, r[0] - 2), r[0]) === '\n\n';
        if (blankBefore) while (text[r[1]] === '\n') r[1] += 1;
    }
    return merged;
}

function applyEdits(text, edits) {
    return [...edits].sort((x, y) => y.start - x.start || y.end - x.end)
        .reduce((t, e) => t.slice(0, e.start) + e.text + t.slice(e.end), text);
}

function parseErrors(file, text) {
    const ts = loadTs();
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    return sf.parseDiagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
}


/** Initializer that can be evaluated once per name without changing behaviour. */
function pureInit(ts, e) {
    if (!e) return false;
    if (ts.isIdentifier(e) || e.kind === ts.SyntaxKind.ThisKeyword || ts.isStringLiteral(e) || ts.isNumericLiteral(e)) return true;
    if (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) return pureInit(ts, e.expression);
    if (ts.isPropertyAccessExpression(e)) return pureInit(ts, e.expression);
    if (ts.isElementAccessExpression(e)) return pureInit(ts, e.expression) && (ts.isStringLiteral(e.argumentExpression) || ts.isNumericLiteral(e.argumentExpression));
    if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'require') return e.arguments.length === 1 && ts.isStringLiteral(e.arguments[0]);
    return false;
}

/**
 * Splits multi-name declarations whose names are only partly wanted into one
 * declaration per name: `const a = 1, b = 2;` and `const { a, b } = x;`.
 * Returns { text, done, refused } (`text` equals a.text when nothing changed).
 */
function splitDeclarations(a, want) {
    const { ts, sf, text } = a;
    const edits = [];
    const done = [];
    const refused = new Map(); // name -> refusal
    const seen = new Set();
    for (const name of want) {
        const i = a.nameToUnit.get(name);
        if (i === undefined || seen.has(i)) continue;
        seen.add(i);
        const u = a.units[i];
        if (!ts.isVariableStatement(u.node) || u.names.length < 2 || u.names.every((n) => want.has(n))) continue;
        const st = u.node;
        const decls = st.declarationList.declarations;
        const prefix = text.slice(st.getStart(sf), decls[0].getStart(sf));
        const pieces = [];
        let reason = null;
        for (const d of decls) {
            const names = [];
            const collect = (nm) => { if (ts.isIdentifier(nm)) names.push(nm.text); else for (const el of nm.elements) if (!ts.isOmittedExpression(el)) collect(el.name); };
            collect(d.name);
            const partial = names.some((n) => want.has(n)) && names.some((n) => !want.has(n));
            if (ts.isObjectBindingPattern(d.name) && d.name.elements.length > 1 && partial) {
                if (d.name.elements.some((el) => el.dotDotDotToken)) { reason = 'a rest element (...rest) cannot be split; list every name of this destructuring'; break; }
                if (!pureInit(ts, d.initializer)) { reason = 'the initializer of this destructuring is not a plain identifier / member chain / require(\'x\'), and splitting would evaluate it once per name; list every name of the declaration'; break; }
                const typeText = d.type ? `: ${d.type.getText(sf)}` : '';
                for (const el of d.name.elements) pieces.push(`${prefix}{ ${el.getText(sf)} }${typeText} = ${d.initializer.getText(sf)};`);
            } else if (ts.isArrayBindingPattern(d.name) && partial) {
                reason = 'an array destructuring cannot be split by name; list every name of the declaration';
                break;
            } else if (partial) {
                reason = 'a nested destructuring pattern holds several of the names; list all of them';
                break;
            } else pieces.push(`${prefix}${d.getText(sf)};`);
        }
        if (reason) { for (const n of u.names) refused.set(n, { name: u.names.join('+'), reason, suggest: `list ${u.names.join(',')} in --move` }); continue; }
        edits.push({ start: st.getStart(sf), end: st.getEnd(), text: pieces.join('\n') });
        done.push(`${u.names.join('+')} -> ${pieces.length} declarations`);
    }
    return { text: applyEdits(text, edits), done, refused };
}

export function split({ file, move, to, dry = false, rewriteImporters = false, preview = false, closure = false, cwd = process.cwd() }) {
    const abs = path.resolve(cwd, file);
    const result = { moved: [], refused: [], created: [], touched: [], mockReferences: [], warnings: [], dry };
    const segs = abs.split(path.sep);
    if (rewriteImporters && segs.includes('server')) {
        result.refused.push({ name: '*', reason: '--rewrite-importers is for agent-hub only (files under server/ are CommonJS; the old file keeps working through its re-export)' });
        return { exitCode: 2, result };
    }
    let a = analyze(abs);
    const originalLineCount = a.lineCount;
    const ts = a.ts;
    let sibling = path.resolve(cwd, to);
    if (!path.extname(sibling)) sibling += path.extname(abs);
    if (fs.existsSync(sibling)) { result.refused.push({ name: '*', reason: `${shown(sibling)} exists already; pick a new sibling` }); return { exitCode: 2, result }; }
    if (sibling === abs) { result.refused.push({ name: '*', reason: 'the sibling is the file itself' }); return { exitCode: 2, result }; }

    // Split partly wanted multi-name declarations, and with --closure grow the set to what it references.
    const want = new Set(move);
    const added = [];
    const splitDone = [];
    let splitRefusals = new Map();
    for (let round = 0; round < 200; round++) {
        const sp = splitDeclarations(a, want);
        splitRefusals = sp.refused;
        if (sp.text !== a.text) { splitDone.push(...sp.done); a = analyze(abs, sp.text); }
        if (!closure) break;
        let grew = false;
        for (const name of [...want]) {
            const i = a.nameToUnit.get(name);
            if (i === undefined || a.units[i].isDefault) continue;
            for (const r of a.units[i].refNames) if (a.nameToUnit.has(r) && !want.has(r)) { want.add(r); added.push(r); grew = true; }
        }
        if (!grew) break;
    }
    if (splitDone.length) result.splitDeclarations = splitDone;
    if (closure) result.closure = { requested: move, added };

    // Resolve the names.
    const moving = new Set();
    for (const name of want) {
        const i = a.nameToUnit.get(name);
        if (i === undefined) {
            result.refused.push({ name, reason: a.bindings.has(name) ? 'an import binding, not a declaration (it is copied into the sibling when the moved code uses it)' : 'not a top-level declaration of this file' });
        } else if (a.units[i].isDefault) result.refused.push({ name, reason: 'default export; cannot be re-exported under the same shape' });
        else if (a.units[i].names.length > 1 && a.units[i].names.some((n) => !want.has(n))) {
            const u = a.units[i];
            const r = splitRefusals.get(name);
            if (!result.refused.some((x) => x.name === (r?.name ?? u.names.join('+')))) result.refused.push(r ?? { name: u.names.join('+'), reason: 'one declaration holds several names and not all are listed', suggest: `list ${u.names.join(',')} in --move` });
        } else moving.add(i);
    }
    // Refuse what would import back.
    const reasons = new Map();
    for (const i of moving) {
        const u = a.units[i];
        const back = u.refs.filter((r) => !moving.has(r));
        if (back.length) {
            const names = [...new Set(back.map((r) => a.units[r].names.join('+')))];
            reasons.set(i, { name: u.names.join('+'), reason: 'references declarations that stay (the sibling would import back)', dependsOn: names, suggest: `add ${names.join(',')} to --move (or their whole closure: ts-outline.mjs lists it)` });
        }
        if (u.mutable && a.units.some((o) => !moving.has(o.index) && o.refs.includes(i))) {
            reasons.set(i, { name: u.names.join('+'), reason: 'let/var binding used by code that stays (an import is read-only and, in CommonJS, a copy)' });
        }
    }
    result.refused.push(...reasons.values());
    if (result.refused.length || !moving.size) {
        if (!moving.size && !result.refused.length) result.refused.push({ name: '*', reason: 'nothing to move' });
        return { exitCode: 2, result };
    }

    const text = a.text;
    const movedUnits = [...moving].sort((x, y) => x - y).map((i) => a.units[i]);
    const movedNames = movedUnits.flatMap((u) => u.names);
    const staying = a.units.filter((u) => !moving.has(u.index));
    const usedByStaying = new Set(staying.flatMap((u) => [...u.refNames]));
    const esm = a.moduleStyle === 'esm';
    const isTypeUnit = (u) => u.kind === 'interface' || u.kind === 'type';
    const needed = movedUnits.flatMap((u) => u.names).filter((n) => usedByStaying.has(n) || a.units[a.nameToUnit.get(n)].exported);

    // The sibling.
    const sameDir = path.dirname(sibling) === path.dirname(abs);
    const blocks = movedUnits.map((u) => {
        let block = text.slice(u.start, u.end);
        const at = u.node.getStart(a.sf) - u.start;
        if (esm && u.names.some((n) => needed.includes(n)) && !u.node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
            block = `${block.slice(0, at)}export ${block.slice(at)}`;
        }
        return block;
    });
    const useGroups = new Map(); // import stmt -> Set(bindings)
    for (const u of movedUnits) for (const local of u.importUses) {
        const b = a.bindings.get(local);
        if (!useGroups.has(b.stmt)) useGroups.set(b.stmt, new Set());
        useGroups.get(b.stmt).add(b);
    }
    const sibDir = path.dirname(sibling);
    const importLines = [...useGroups].sort((x, y) => a.importStmts.indexOf(x[0]) - a.importStmts.indexOf(y[0])).map(([stmt, set]) => {
        const used = stmt.bindings.filter((b) => set.has(b));
        let spec = stmt.spec;
        if (spec.startsWith('.') && !sameDir) {
            const target = path.resolve(path.dirname(abs), spec);
            let r = posix(path.relative(sibDir, target));
            if (!r.startsWith('.')) r = `./${r}`;
            spec = r;
        }
        return renderImport(stmt, used, spec);
    });
    const header = a.typecheck ? `${a.typecheck}\n` : '';
    const exportsOut = esm ? '' : `\nmodule.exports = { ${needed.join(', ')} };\n`;
    const sibText = `${header}${importLines.length ? `${importLines.join('\n')}\n\n` : header ? '\n' : ''}${blocks.join('\n\n')}\n${exportsOut}`;
    if (/__dirname|__filename|import\.meta|require\.resolve/.test(blocks.join('\n')) && !sameDir) {
        result.warnings.push('moved code uses __dirname / __filename / import.meta / require.resolve and the sibling is in another directory');
    }

    // The old file.
    const edits = [];
    const removals = movedUnits.map((u) => [u.start, u.end]);
    const dropped = new Set(); // import bindings used only by moved code
    for (const b of a.bindings.values()) {
        const users = a.units.filter((u) => u.importUses.has(b.local));
        if (users.length && users.every((u) => moving.has(u.index))) dropped.add(b);
    }
    for (const stmt of a.importStmts) {
        const gone = stmt.bindings.filter((b) => dropped.has(b));
        if (!gone.length) continue;
        const keep = stmt.bindings.filter((b) => !dropped.has(b));
        const s = stmt.node.getStart(a.sf);
        if (!keep.length) removals.push([s, stmt.node.getEnd()]); else edits.push({ start: s, end: stmt.node.getEnd(), text: renderImport(stmt, keep, stmt.spec) });
    }
    for (const [x, y] of mergeRemovals(text, removals)) edits.push({ start: x, end: y, text: '' });
    // The line that brings the moved names back.
    const q = a.importStmts.length ? quoteOf(a.importStmts[0]) : "'";
    const sibSpec = relSpec(path.dirname(abs), sibling, usesJsExt(a) ? 'js' : undefined);
    const back = [...new Set(movedNames.filter((n) => usedByStaying.has(n)))];
    const reexport = esm ? movedUnits.filter((u) => u.node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).flatMap((u) => u.names.map((n) => ({ n, t: isTypeUnit(u) }))) : [];
    const tag = (n) => `${isTypeUnit(a.units[a.nameToUnit.get(n)]) ? 'type ' : ''}${n}`;
    const lines = [];
    if (back.length) lines.push(esm ? `import { ${back.map(tag).join(', ')} } from ${q}${sibSpec}${q};` : `const { ${back.join(', ')} } = require(${q}${sibSpec}${q});`);
    if (reexport.length) lines.push(`export { ${reexport.map((x) => (x.t ? `type ${x.n}` : x.n)).join(', ')} } from ${q}${sibSpec}${q};`);
    if (!esm && !back.length) {
        // Exported by a module.exports line that now has no local binding to point at.
        const exportsOnly = movedNames.filter((n) => a.units[a.nameToUnit.get(n)].exported);
        if (exportsOnly.length) lines.push(`const { ${exportsOnly.join(', ')} } = require(${q}${sibSpec}${q});`);
    }
    if (lines.length) {
        // After the leading run of imports / directives, else before the first statement.
        let last = null;
        for (const st of a.sf.statements) {
            const imp = a.importStmts.find((s) => s.node === st);
            if (imp || (ts.isExpressionStatement(st) && ts.isStringLiteral(st.expression))) last = st; else break;
        }
        let pos;
        let insert = `${lines.join('\n')}\n`;
        if (last) {
            const eol = text.indexOf('\n', last.getEnd());
            if (eol === -1) { pos = text.length; insert = `\n${lines.join('\n')}`; } else pos = eol + 1;
            const hit = edits.find((e) => e.text === '' && e.start < pos && pos < e.end);
            if (hit) pos = hit.end;
        } else {
            const first = a.units[0];
            pos = lineStart(text, first ? first.start : 0);
            insert += '\n';
        }
        edits.push({ start: pos, end: pos, text: insert });
    }
    let oldText = applyEdits(text, edits);
    // Imports are the last non-statement lines: tidy a blank line left at the top.
    oldText = oldText.replace(/^\n+/, '');

    // Safety: both results must parse.
    const problems = [...parseErrors(abs, oldText).map((m) => `${path.basename(abs)}: ${m}`), ...parseErrors(sibling, sibText).map((m) => `${path.basename(sibling)}: ${m}`)];
    if (problems.length) { result.refused.push({ name: '*', reason: `the result does not parse: ${problems.slice(0, 3).join('; ')}` }); return { exitCode: 2, result }; }

    result.moved = movedNames;
    result.created = [shown(sibling)];
    result.touched = [shown(abs)];
    result.lines = { old: { before: originalLineCount, after: oldText.split('\n').length - (oldText.endsWith('\n') ? 1 : 0) }, sibling: sibText.split('\n').length - 1 };
    if (preview) result.preview = { old: oldText, sibling: sibText };
    const writes = [[abs, oldText], [sibling, sibText]];

    // Mock / stub references and importers.
    const pkg = packageRoot(abs);
    const aliases = readAliases(pkg);
    for (const w of testCouplings(abs, findTests(abs))) {
        result.testCouplings ??= [];
        result.testCouplings.push({ ...w, file: shown(w.file) });
        result.warnings.push(`${shown(w.file)}:${w.line} ${w.message}`);
    }
    const stem = path.basename(abs).replace(/\.[cm]?[jt]sx?$/, '');
    const stemRe = new RegExp(`${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    for (const f of walk(pkg, (n) => SOURCE_FILE_RE.test(n))) {
        if (f === abs || f === sibling) continue;
        const t = fs.readFileSync(f, 'utf8');
        if (!stemRe.test(t)) continue;
        for (const m of mockRefs(t, f, aliases, abs)) result.mockReferences.push({ ...m, file: shown(m.file) });
        if (!rewriteImporters) continue;
        const nt = rewriteImportsIn(a.ts, f, t, aliases, abs, sibling, new Set(movedNames));
        if (nt !== t) { writes.push([f, nt]); result.touched.push(shown(f)); }
    }
    if (!dry) {
        fs.mkdirSync(sibDir, { recursive: true });
        for (const [f, t] of writes) fs.writeFileSync(f, t);
    }
    return { exitCode: 0, result };
}

/** Re-point `import { moved } from old` / `export { moved } from old` at the sibling. */
function rewriteImportsIn(ts, file, text, aliases, oldFile, sibling, movedNames) {
    const kind = /\.tsx$/.test(file) ? ts.ScriptKind.TSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const edits = [];
    const newSpec = (orig) => {
        if (orig.startsWith('.')) return relSpec(path.dirname(file), sibling, /\.[cm]?js$/.test(orig) ? 'js' : undefined);
        const al = aliases.find(([, dir]) => sibling.startsWith(dir));
        if (al && orig.startsWith(al[0])) return al[0] + posix(sibling.slice(al[1].length)).replace(/\.(?:tsx?|jsx?)$/, '');
        return relSpec(path.dirname(file), sibling);
    };
    for (const st of sf.statements) {
        const isImp = ts.isImportDeclaration(st); const isExp = ts.isExportDeclaration(st);
        if (!(isImp || isExp) || !st.moduleSpecifier || !specIsFile(file, st.moduleSpecifier.text, aliases, oldFile)) continue;
        const named = isImp ? (st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings) ? st.importClause.namedBindings : null) : (st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause : null);
        if (!named) continue;
        const moved = named.elements.filter((e) => movedNames.has((e.propertyName || e.name).text));
        if (!moved.length) continue;
        const q = st.moduleSpecifier.getText().startsWith('"') ? '"' : "'";
        const spec = newSpec(st.moduleSpecifier.text);
        const typeKw = (isImp ? st.importClause.isTypeOnly : st.isTypeOnly) ? 'type ' : '';
        const rest = named.elements.filter((e) => !moved.includes(e));
        const mk = (els, sp) => {
            const list = `{ ${els.map((e) => e.getText(sf)).join(', ')} }`;
            if (isExp) return `export ${typeKw}${list} from ${q}${sp}${q};`;
            const def = st.importClause.name?.text;
            return `import ${typeKw}${def ? `${def}, ` : ''}${list} from ${q}${sp}${q};`;
        };
        if (!rest.length) {
            edits.push({ start: st.moduleSpecifier.getStart(sf) + 1, end: st.moduleSpecifier.getEnd() - 1, text: spec });
        } else {
            const mkMoved = isImp && st.importClause.name ? `import ${typeKw}{ ${moved.map((e) => e.getText(sf)).join(', ')} } from ${q}${spec}${q};` : mk(moved, spec);
            edits.push({ start: st.getStart(sf), end: st.getEnd(), text: `${mk(rest, st.moduleSpecifier.text)}\n${mkMoved}` });
        }
    }
    return edits.length ? applyEdits(text, edits) : text;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const val = (flag) => { const i = args.indexOf(flag); return i === -1 ? null : args[i + 1]; };
    const file = args.find((x, i) => !x.startsWith('--') && !['--move', '--to'].includes(args[i - 1]));
    const move = (val('--move') || '').split(',').map((s) => s.trim()).filter(Boolean);
    const to = val('--to');
    if (!file || !move.length || !to) {
        console.error('usage: node scripts/ts-split.mjs <file> --move A,B,C --to <sibling path> [--dry] [--rewrite-importers] [--preview] [--closure]');
        process.exit(2);
    }
    const { exitCode, result } = split({ file, move, to, dry: args.includes('--dry'), rewriteImporters: args.includes('--rewrite-importers'), preview: args.includes('--preview') });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = exitCode;
}
