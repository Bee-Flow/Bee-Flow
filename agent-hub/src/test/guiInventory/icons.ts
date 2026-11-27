/**
 * The identity of an icon in the GUI inventory: the name the declaring file
 * imports it under from lucide-react (`History`, although lucide names the same
 * component `RotateCcwClock`), so the golden says what the source says; a
 * component lucide does not know by that file's imports keeps its display name,
 * an emoji or a glyph is itself, and a React element is named by its type.
 */

import * as lucide from 'lucide-react';
import ts from 'typescript';
import { iconId } from './gates';
import { loadSource } from './sourceAst';

const namesCache = new Map<string, string[]>();

/** The names a web file imports from lucide-react (value imports only). */
export function lucideImports(treePath: string): string[] {
    const hit = namesCache.get(treePath);
    if (hit) return hit;
    const names: string[] = [];
    for (const st of loadSource(treePath).sf.statements) {
        if (!ts.isImportDeclaration(st) || (st.moduleSpecifier as ts.StringLiteral).text !== 'lucide-react') continue;
        const named = st.importClause?.namedBindings;
        if (st.importClause?.isTypeOnly || !named || !ts.isNamedImports(named)) continue;
        for (const el of named.elements) if (!el.isTypeOnly) names.push((el.propertyName ?? el.name).text);
    }
    namesCache.set(treePath, names);
    return names;
}

const table = new Map<string, unknown>(Object.entries(lucide));

/** The icon's name as `declaringFiles` import it, else iconId(). */
export function iconName(icon: unknown, declaringFiles: readonly string[]): string | null {
    const component = (icon as { $$typeof?: symbol; type?: unknown })?.type && (icon as { $$typeof?: symbol }).$$typeof
        ? (icon as { type: unknown }).type
        : icon;
    for (const file of declaringFiles) {
        const name = lucideImports(file).find((n) => table.get(n) === component);
        if (name) return name;
    }
    return iconId(icon);
}
