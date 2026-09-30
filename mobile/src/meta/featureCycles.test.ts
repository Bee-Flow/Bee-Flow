/**
 * No two features import each other at runtime.
 *
 * A feature reaches another only through its index (eslint.config.js), and an
 * index loads the whole feature: its screens, and every feature THOSE import.
 * So a two-way edge is a module cycle, and it works only while every symbol
 * that crosses it happens to be read lazily. A screen that composes several
 * features (the Cowork hub, the list of every conversation) is a feature of
 * its own above them, not a part of one of them.
 *
 * Type-only imports are erased at build time and cannot form a cycle, so they
 * do not count.
 */

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const FEATURES = path.resolve(__dirname, '../features');

type Graph = Map<string, Map<string, string>>;

/** The features a source file loads at runtime, from its import/export specifiers. */
export function runtimeFeatureImports(file: string, src: string): string[] {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    const out: string[] = [];
    for (const node of sf.statements) {
        let spec: ts.Expression | undefined;
        if (ts.isImportDeclaration(node)) {
            const clause = node.importClause;
            const named = clause?.namedBindings;
            const typeOnly =
                clause?.isTypeOnly ||
                (clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 &&
                    named.elements.every((el) => el.isTypeOnly));
            if (!typeOnly) spec = node.moduleSpecifier;
        } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            const clause = node.exportClause;
            const typeOnly =
                node.isTypeOnly ||
                (clause && ts.isNamedExports(clause) && clause.elements.length > 0 &&
                    clause.elements.every((el) => el.isTypeOnly));
            if (!typeOnly) spec = node.moduleSpecifier;
        }
        const name = spec && ts.isStringLiteral(spec) ? /^@\/features\/([^/]+)/.exec(spec.text)?.[1] : undefined;
        if (name) out.push(name);
    }
    return out;
}

/** Every cycle in the graph, each as the features in order, smallest first. */
export function cyclesOf(graph: Graph): string[][] {
    const found: string[][] = [];
    const walk = (start: string, node: string, trail: string[]) => {
        for (const next of graph.get(node)?.keys() ?? []) {
            if (next === start) found.push(trail);
            else if (next > start && !trail.includes(next)) walk(start, next, [...trail, next]);
        }
    };
    for (const start of [...graph.keys()].sort()) walk(start, start, [start]);
    return found;
}

function* sourceFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* sourceFiles(p);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield p;
    }
}

function featureGraph(): Graph {
    const graph: Graph = new Map();
    for (const file of sourceFiles(FEATURES)) {
        const from = path.relative(FEATURES, file).split(path.sep)[0] as string;
        for (const to of runtimeFeatureImports(file, fs.readFileSync(file, 'utf8'))) {
            if (to === from) continue;
            const edges = graph.get(from) ?? new Map<string, string>();
            if (!edges.has(to)) edges.set(to, path.relative(FEATURES, file));
            graph.set(from, edges);
        }
    }
    return graph;
}

describe('the detector', () => {
    // Without these, a detector that found nothing would pass whatever the tree did.
    it('counts value imports and skips type-only ones', () => {
        const src = [
            "import { a } from '@/features/one';",
            "import type { B } from '@/features/two';",
            "import { type C } from '@/features/three';",
            "import { d, type E } from '@/features/four/index';",
            "export { f } from '@/features/five';",
            "export type { G } from '@/features/six';",
        ].join('\n');
        expect(runtimeFeatureImports('x.ts', src)).toEqual(['one', 'four', 'five']);
    });

    it('finds a cycle through three features', () => {
        const graph: Graph = new Map([
            ['a', new Map([['b', 'a.ts']])],
            ['b', new Map([['c', 'b.ts']])],
            ['c', new Map([['a', 'c.ts']])],
        ]);
        expect(cyclesOf(graph)).toEqual([['a', 'b', 'c']]);
    });
});

describe('src/features', () => {
    it('has no runtime import cycle between features', () => {
        const graph = featureGraph();
        // Each cycle with the file behind every edge, so the failure says where to cut.
        const cycles = cyclesOf(graph).map((cycle) =>
            cycle.map((from, i) => {
                const to = cycle[(i + 1) % cycle.length] as string;
                return `${from} -> ${to} (${graph.get(from)?.get(to)})`;
            }),
        );
        expect(cycles).toEqual([]);
    });
});
