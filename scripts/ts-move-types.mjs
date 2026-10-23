#!/usr/bin/env node
// Moves a converted file's top-level interfaces and type aliases into a
// sibling `<Name>.types.ts`: for a file the added types pushed past its line
// ceiling (scripts/file-budget.mjs) the types go, the code stays.
//
// Only declarations move, each with its own JSDoc (a free-standing comment
// stays where it is). The types file imports, type-only, what the moved
// declarations name; the source imports them back with one `import type` and
// re-exports the ones it exported. A declaration that names something local to
// the file (a value, a class, a type that cannot move) stays.
//
//   node scripts/ts-move-types.mjs agent-hub/src/a/B.tsx [more files]

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB = path.join(ROOT, 'agent-hub');

/** Names a type node refers to (left-most identifier of each reference and typeof query). */
function namesIn(ts, node) {
    const out = new Set();
    const visit = (n) => {
        if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n) || ts.isTypeQueryNode(n)) {
            let e = ts.isTypeReferenceNode(n) ? n.typeName : ts.isTypeQueryNode(n) ? n.exprName : n.expression;
            while (e && (ts.isQualifiedName(e) || ts.isPropertyAccessExpression(e))) e = ts.isQualifiedName(e) ? e.left : e.expression;
            if (e && ts.isIdentifier(e)) out.add(e.text);
        }
        ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
}

export function moveTypes(ts, source, fileName) {
    const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const imports = new Map(); // local name -> { spec, imported, kind }
    const localNames = new Set();
    for (const st of sf.statements) {
        if (ts.isImportDeclaration(st) && st.importClause) {
            const spec = st.moduleSpecifier.text; const c = st.importClause;
            if (c.name) imports.set(c.name.text, { spec, kind: 'default' });
            if (c.namedBindings && ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, { spec, kind: 'ns' });
            if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) imports.set(e.name.text, { spec, kind: 'named', imported: (e.propertyName || e.name).text });
            continue;
        }
        if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) { if (ts.isIdentifier(d.name)) localNames.add(d.name.text); }
        else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) localNames.add(st.name.text);
    }
    const decls = sf.statements.filter((s) => ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s));
    let moving = new Set(decls.map((d) => d.name.text));
    // Drop what names a local value or a type that stays; repeat until stable.
    for (let changed = true; changed;) {
        changed = false;
        for (const d of decls) {
            if (!moving.has(d.name.text)) continue;
            for (const n of namesIn(ts, d)) {
                if (localNames.has(n) || (decls.some((o) => o.name.text === n) && !moving.has(n))) { moving.delete(d.name.text); changed = true; break; }
            }
        }
    }
    if (!moving.size) return null;
    const moved = decls.filter((d) => moving.has(d.name.text));
    const needed = new Map();
    for (const d of moved) for (const n of namesIn(ts, d)) if (imports.has(n)) needed.set(n, imports.get(n));
    const startOf = (d) => (d.jsDoc && d.jsDoc.length ? d.jsDoc[0].getStart(sf) : d.getStart(sf));
    const blocks = moved.map((d) => {
        const text = source.slice(startOf(d), d.getEnd());
        return d.modifiers && d.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ? text : text.replace(/^((?:\/\*\*[\s\S]*?\*\/\s*)?)(interface|type)\b/, '$1export $2');
    });
    // The types file: what the declarations name, type-only, then the declarations.
    const bySpec = new Map();
    for (const [local, im] of needed) {
        if (!bySpec.has(im.spec)) bySpec.set(im.spec, []);
        bySpec.get(im.spec).push({ local, ...im });
    }
    const head = [];
    for (const [spec, list] of bySpec) {
        for (const x of list.filter((x) => x.kind === 'default')) head.push(`import type ${x.local} from '${spec}';`);
        for (const x of list.filter((x) => x.kind === 'ns')) head.push(`import type * as ${x.local} from '${spec}';`);
        const named = list.filter((x) => x.kind === 'named').map((x) => (x.imported === x.local ? x.local : `${x.imported} as ${x.local}`));
        if (named.length) head.push(`import type { ${named.join(', ')} } from '${spec}';`);
    }
    const typesText = `${head.length ? `${head.join('\n')}\n\n` : ''}${blocks.join('\n\n')}\n`;
    // The source: declarations out (with the newline after each), one import back.
    let out = source;
    for (const d of [...moved].sort((a, b) => b.getEnd() - a.getEnd())) {
        let end = d.getEnd(); while (out[end] === '\n' && out[end + 1] === '\n') end++;
        if (out[end] === '\n') end++;
        out = out.slice(0, startOf(d)) + out.slice(end);
    }
    const base = `./${path.basename(fileName).replace(/\.tsx?$/, '')}.types`;
    const names = moved.map((d) => d.name.text);
    const exported = moved.filter((d) => d.modifiers && d.modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)).map((d) => d.name.text);
    const sf2 = ts.createSourceFile(fileName, out, ts.ScriptTarget.Latest, true, /\.tsx$/.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const lastImport = [...sf2.statements].reverse().find((s) => ts.isImportDeclaration(s));
    const at = lastImport ? lastImport.getEnd() : 0;
    const add = `${lastImport ? '\n' : ''}import type { ${names.join(', ')} } from '${base}';${exported.length ? `\nexport type { ${exported.join(', ')} } from '${base}';` : ''}${lastImport ? '' : '\n'}`;
    out = out.slice(0, at) + add + out.slice(at);
    return { source: out, types: typesText, moved: names };
}

/**
 * Puts `types` (a generated `<Name>.types.ts` text) into an existing types
 * file: its imports join the existing ones (one naming that file itself is
 * dropped), its declarations go at the end.
 */
export function mergeInto(existing, types, existingBase) {
    const lines = types.split('\n');
    const imports = lines.filter((l) => l.startsWith('import type ') && !l.includes(`'./${existingBase}'`));
    const body = lines.filter((l) => !l.startsWith('import type ')).join('\n').replace(/^\n+|\n+$/g, '');
    const old = existing.split('\n');
    const last = old.reduce((acc, l, i) => (l.startsWith('import ') ? i : acc), -1);
    const add = imports.filter((l) => !old.includes(l));
    return `${[...old.slice(0, last + 1), ...add, ...old.slice(last + 1)].join('\n').replace(/\n+$/, '')}\n\n${body}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const ts = createRequire(path.join(HUB, 'package.json'))('typescript');
    const { mergeTypeImports } = await import('./ts-merge-type-imports.mjs');
    for (const arg of process.argv.slice(2)) {
        const file = path.resolve(arg);
        const dir = path.dirname(file);
        const wanted = path.basename(file).replace(/\.tsx?$/, '.types.ts');
        // A types file whose name differs only in case (studioMap.types.ts beside
        // StudioMap.tsx) is the module's types file already: merge into it, never
        // put a second one next to it (a case-insensitive disk sees one name).
        const existing = fs.readdirSync(dir).find((f) => f.toLowerCase() === wanted.toLowerCase());
        const target = path.join(dir, existing || wanted);
        const before = fs.readFileSync(file, 'utf8');
        const r = moveTypes(ts, before, file);
        if (!r) { console.error(`${arg}: nothing can move`); continue; }
        const backup = `${file}.before-move-types`;
        fs.writeFileSync(backup, before);
        const base = path.basename(target).replace(/\.ts$/, '');
        let source = r.source.replace(`from './${path.basename(wanted).replace(/\.ts$/, '')}';`, `from './${base}';`);
        source = source.replaceAll(`from './${path.basename(wanted).replace(/\.ts$/, '')}';`, `from './${base}';`);
        fs.writeFileSync(file, mergeTypeImports(source));
        fs.writeFileSync(target, existing ? mergeInto(fs.readFileSync(target, 'utf8'), r.types, base) : r.types);
        console.error(`${arg}: ${r.moved.length} declaration(s) -> ${path.relative(ROOT, target)}${existing ? ' (merged)' : ''}; backup ${path.relative(ROOT, backup)}`);
    }
}
