/**
 * Read the parts of the GUI that are JSX or lazy imports with the TypeScript
 * compiler API (never a regular expression over source text): which component
 * a map entry, a page branch or a provider renders, and the tree path of the
 * file it imports. Used by the `*.inventory.test.ts` goldens.
 *
 * A component is named by the file it comes from: an import binding, or a
 * `lazy(() => import('…'))` assigned to a variable or a property (its anchor).
 * A tag that is a function of the same file is followed into its body, so a
 * local wrapper (`function LicensePage`) reports the panels it draws.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { webFile } from './ownership';

export interface SourceInfo {
    treePath: string;
    sf: ts.SourceFile;
    /** Local name -> tree path of the web file it is imported from (packages: absent). */
    bindings: Map<string, string>;
    /** Anchor (variable or property name) -> tree path of the file its `import()` loads. */
    lazies: Map<string, string>;
    /** Top-level functions and arrow-function constants of the file, by name. */
    locals: Map<string, ts.Node>;
}

export interface ComponentRef {
    name: string;
    file: string | null;
}

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

/** The tree path of a web import (`@/…`, `@shared/…` or relative), or null for a package or a missing file. */
export function resolveImport(fromTreePath: string, spec: string): string | null {
    let base: string;
    if (spec.startsWith('@/')) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith('@shared/')) base = `src/shared/${spec.slice(8)}`;
    else if (spec.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(fromTreePath), spec));
    else return null;
    for (const ext of EXTENSIONS) {
        const abs = webFile(base + ext);
        if (abs && fs.statSync(abs).isFile()) return base + ext;
    }
    return null;
}

function importBindings(sf: ts.SourceFile, from: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const st of sf.statements) {
        if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
        const target = resolveImport(from, (st.moduleSpecifier as ts.StringLiteral).text);
        if (!target) continue;
        const clause = st.importClause;
        if (clause.name) out.set(clause.name.text, target);
        const named = clause.namedBindings;
        if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) if (!el.isTypeOnly) out.set(el.name.text, target);
        }
        if (named && ts.isNamespaceImport(named)) out.set(named.name.text, target);
    }
    return out;
}

/** The name of the variable or property an expression is assigned to, nearest first. */
function anchorOf(node: ts.Node): string | null {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
        if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
        if (ts.isPropertyAssignment(at) && (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))) return at.name.text;
    }
    return null;
}

function lazyImports(sf: ts.SourceFile, from: string): Map<string, string> {
    const out = new Map<string, string>();
    const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
            const arg = node.arguments[0];
            const anchor = anchorOf(node);
            const target = arg && ts.isStringLiteral(arg) ? resolveImport(from, arg.text) : null;
            if (anchor && target && !out.has(anchor)) out.set(anchor, target);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

function localFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
    const out = new Map<string, ts.Node>();
    for (const st of sf.statements) {
        if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, st);
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))) {
                out.set(d.name.text, d.initializer);
            }
        }
    }
    return out;
}

const cache = new Map<string, SourceInfo>();

/** Parse a web file by tree path (any root). */
export function loadSource(treePath: string): SourceInfo {
    const hit = cache.get(treePath);
    if (hit) return hit;
    const abs = webFile(treePath);
    if (!abs) throw new Error(`web file ${treePath} is in no root`);
    const kind = treePath.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, kind);
    const info = { treePath, sf, bindings: importBindings(sf, treePath), lazies: lazyImports(sf, treePath), locals: localFunctions(sf) };
    cache.set(treePath, info);
    return info;
}

/** The component name of a JSX tag: an upper-case identifier, or the head of `A.B`; null for an HTML tag. */
function tagName(tag: ts.JsxTagNameExpression): string | null {
    let head: ts.Node = tag;
    while (ts.isPropertyAccessExpression(head)) head = head.expression;
    if (!ts.isIdentifier(head)) return null;
    return /^[A-Z]/.test(head.text) ? head.text : null;
}

/**
 * The file a name of a source comes from: its own lazy import, else its import
 * binding, followed through a module that only holds lazy slots
 * (`export const CoworkPage = lazy(() => import('…'))`, AgentHub/hubLazySlots.tsx).
 */
export function fileOfName(info: SourceInfo, name: string): string | null {
    const own = info.lazies.get(name);
    if (own) return own;
    const bound = info.bindings.get(name);
    if (!bound || !/\.[jt]sx?$/.test(bound)) return bound ?? null;
    return loadSource(bound).lazies.get(name) ?? bound;
}

/** Every component a node renders, in order of first appearance, local wrappers and slot functions followed. */
export function componentRefs(info: SourceInfo, node: ts.Node, seen = new Set<string>()): ComponentRef[] {
    const out: ComponentRef[] = [];
    const add = (name: string, asCall = false) => {
        if (seen.has(name)) return;
        const file = asCall ? null : fileOfName(info, name);
        const local = file ? null : info.locals.get(name);
        if (asCall && !local) return;
        seen.add(name);
        if (local) out.push(...componentRefs(info, local, seen));
        else out.push({ name, file });
    };
    const visit = (n: ts.Node) => {
        if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
            const name = tagName(n.tagName);
            if (name) add(name);
        }
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) add(n.expression.text, true);
        ts.forEachChild(n, visit);
    };
    visit(node);
    return out;
}

/** Strip `as`, `satisfies` and parentheses off an expression. */
function unwrap(node: ts.Expression): ts.Expression {
    let at = node;
    while (ts.isAsExpression(at) || ts.isSatisfiesExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
    return at;
}

/** The initializer of a top-level `const name = …`. */
export function constInitializer(info: SourceInfo, name: string): ts.Expression {
    for (const st of info.sf.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
            if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return unwrap(d.initializer);
        }
    }
    throw new Error(`${info.treePath} has no const ${name}`);
}

/** Each property of an object-literal constant, with the components its value renders, in source order. */
export function objectMapRefs(info: SourceInfo, constName: string): { key: string; components: ComponentRef[] }[] {
    const init = constInitializer(info, constName);
    if (!ts.isObjectLiteralExpression(init)) throw new Error(`${info.treePath}: ${constName} is not an object literal`);
    return init.properties.filter(ts.isPropertyAssignment).map((p) => ({
        key: (p.name as ts.Identifier | ts.StringLiteral).text,
        components: componentRefs(info, p.initializer),
    }));
}

/** A string-to-string object-literal constant as data. */
export function stringMap(info: SourceInfo, constName: string): Record<string, string> {
    const init = constInitializer(info, constName);
    if (!ts.isObjectLiteralExpression(init)) throw new Error(`${info.treePath}: ${constName} is not an object literal`);
    const out: Record<string, string> = {};
    for (const p of init.properties) {
        if (ts.isPropertyAssignment(p) && ts.isStringLiteral(p.initializer)) out[(p.name as ts.Identifier | ts.StringLiteral).text] = p.initializer.text;
    }
    return out;
}

/**
 * The rows of an array-literal constant (or one object-literal constant) that
 * the module does not export, as data: string properties as they are, an
 * identifier value by its name (`icon: Users` -> 'Users'), a spread as
 * `{ spread: <name> }`.
 */
export function literalRows(info: SourceInfo, constName: string): Record<string, string>[] {
    const init = constInitializer(info, constName);
    const elements = ts.isArrayLiteralExpression(init) ? [...init.elements] : [init];
    return elements.map((el) => {
        if (ts.isSpreadElement(el)) return { spread: el.expression.getText(info.sf) };
        const row: Record<string, string> = {};
        if (!ts.isObjectLiteralExpression(el)) return row;
        for (const p of el.properties) {
            if (!ts.isPropertyAssignment(p)) continue;
            const v = unwrap(p.initializer);
            const key = (p.name as ts.Identifier | ts.StringLiteral).text;
            if (ts.isStringLiteral(v)) row[key] = v.text;
            else if (ts.isIdentifier(v)) row[key] = v.text;
        }
        return row;
    });
}

/** `ident === 'literal'` with ident one of `names`: the literal, else null. */
function comparedLiteral(test: ts.Expression, names: readonly string[]): string | null {
    const e = unwrap(test);
    if (!ts.isBinaryExpression(e) || e.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
    return ts.isIdentifier(e.left) && names.includes(e.left.text) && ts.isStringLiteral(e.right) ? e.right.text : null;
}

/**
 * The branches of a file that test a discriminant against a literal
 * (`if (page === 'admin')`, `currentPage === 'cowork' ? … : …`) or a flag
 * (`showSettings ? … : …`, flags maps the flag to the literal it stands for):
 * literal -> the components the branch renders.
 */
export function literalBranches(info: SourceInfo, names: readonly string[], flags: Record<string, string> = {}): Map<string, ComponentRef[]> {
    const out = new Map<string, ComponentRef[]>();
    const keyOf = (test: ts.Expression): string | null => {
        const e = unwrap(test);
        // `page === 'x' && more` is still the branch of 'x'.
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return keyOf(e.left);
        return comparedLiteral(e, names) ?? (ts.isIdentifier(e) && Object.hasOwn(flags, e.text) ? flags[e.text] : null);
    };
    const record = (key: string | null, branch: ts.Node) => {
        if (key && !out.has(key)) out.set(key, componentRefs(info, branch));
    };
    const switchCases = (n: ts.SwitchStatement) => {
        const on = unwrap(n.expression);
        if (!ts.isIdentifier(on) || !names.includes(on.text)) return;
        for (const clause of n.caseBlock.clauses) {
            if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) record(clause.expression.text, clause);
        }
    };
    const visit = (n: ts.Node) => {
        if (ts.isIfStatement(n)) record(keyOf(n.expression), n.thenStatement);
        if (ts.isConditionalExpression(n)) record(keyOf(n.condition), n.whenTrue);
        if (ts.isSwitchStatement(n)) switchCases(n);
        ts.forEachChild(n, visit);
    };
    visit(info.sf);
    return out;
}

/** JSX attributes written `name={discriminant === 'literal'}`: attribute name -> literal. */
export function jsxAttributeFlags(info: SourceInfo, discriminant: string): Record<string, string> {
    const out: Record<string, string> = {};
    const visit = (n: ts.Node) => {
        if (ts.isJsxAttribute(n) && n.initializer && ts.isJsxExpression(n.initializer) && n.initializer.expression) {
            const lit = comparedLiteral(n.initializer.expression, [discriminant]);
            if (lit && ts.isIdentifier(n.name)) out[n.name.text] = lit;
        }
        ts.forEachChild(n, visit);
    };
    visit(info.sf);
    return out;
}

export interface TreeNode {
    tag: string;
    depth: number;
    condition?: string;
    file: string | null;
}

function lastJsxReturn(fn: ts.Node): ts.Expression | null {
    let found: ts.Expression | null = null;
    const visit = (n: ts.Node) => {
        if (n !== fn && (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n))) return;
        if (ts.isReturnStatement(n) && n.expression) {
            const e = unwrap(n.expression);
            if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) found = e;
        }
        ts.forEachChild(n, visit);
    };
    visit(fn);
    return found;
}

/**
 * The component tree a function returns last (its main render), outermost
 * first: every upper-case tag with its nesting depth (HTML tags add none), the
 * condition it is rendered under (`cond && <X/>`), and its file.
 */
export function jsxTree(info: SourceInfo, functionName: string): TreeNode[] {
    const fn = info.locals.get(functionName);
    if (!fn) throw new Error(`${info.treePath} has no function ${functionName}`);
    const root = lastJsxReturn(fn);
    if (!root) throw new Error(`${functionName} returns no JSX`);
    const out: TreeNode[] = [];
    const walk = (n: ts.Node, depth: number, condition?: string) => {
        if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
            const tag = tagName(ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName);
            if (tag) out.push({ tag, depth, condition, file: fileOfName(info, tag) });
            if (ts.isJsxElement(n)) n.children.forEach((c) => walk(c, tag ? depth + 1 : depth));
            return;
        }
        if (ts.isJsxFragment(n)) { n.children.forEach((c) => walk(c, depth, condition)); return; }
        if (ts.isJsxExpression(n) && n.expression) {
            const e = unwrap(n.expression);
            if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
                walk(unwrap(e.right), depth, e.left.getText(info.sf));
            }
        }
    };
    walk(root, 0);
    return out;
}
