/**
 * The quality budget stays exact.
 *
 * `quality-budget.json` lists the files allowed over the size limits in
 * ARCHITECTURE.md, each at its measured size, and eslint.config.js relaxes the
 * rules for exactly those numbers. ESLint catches a budgeted file that GROWS;
 * this catches the other direction — a file that shrank or was split keeps an
 * allowance it no longer needs, and a budget that can go stale stops being a
 * ratchet. The measurement is ESLint's own rules (via `Linter`), with the same
 * limits eslint.quality.js hands the config, so the two cannot disagree.
 *
 * The inline style count lives in the same file and is exact too: it may
 * only go down, and going down means lowering the number. It counts every
 * object literal written into a `style` or `…Style` prop — `style={{…}}`, one
 * inside a style array, one a Pressable style function returns — because an
 * object in an array is the same per-render allocation as one on its own.
 */

import { Linter } from 'eslint';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const MOBILE = path.resolve(__dirname, '../..');

// eslint-disable-next-line @typescript-eslint/no-require-imports
const quality = require(path.join(MOBILE, 'eslint.quality.js')) as {
    budget: { files: Record<string, Record<string, number>>; inlineStyles: number };
    limitsFor: (file: string) => Record<string, number>;
    ruleEntry: (rule: string, max: number) => Linter.RuleEntry;
    RULES: string[];
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsParser = require('@typescript-eslint/parser') as Linter.Parser;

const linter = new Linter({ configType: 'flat', cwd: MOBILE });

/**
 * The largest value each rule reports for `src` when checked at the default
 * limits, or nothing for a rule the file already meets. Every size rule puts
 * its number in the message: "(318)" or "a complexity of 17".
 */
function measure(file: string, src: string, rules: string[]): Map<string, number> {
    const limits = quality.limitsFor(file);
    const config: Linter.Config[] = [
        {
            files: ['**/*.ts', '**/*.tsx'],
            languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
            rules: Object.fromEntries(rules.map((rule) => [rule, quality.ruleEntry(rule, limits[rule] as number)])),
        },
    ];
    const out = new Map<string, number>();
    for (const message of linter.verify(src, config, { filename: file })) {
        if (message.fatal) throw new Error(`${file}: ${message.message}`);
        const value = Number((/\((\d+)\)/.exec(message.message) ?? /of (\d+)/.exec(message.message))?.[1]);
        if (message.ruleId && Number.isFinite(value)) {
            out.set(message.ruleId, Math.max(out.get(message.ruleId) ?? 0, value));
        }
    }
    return out;
}

/**
 * Object literals written into a `style` / `…Style` JSX prop. One nested in
 * another (`{ transform: [{ rotate }] }`) is part of it, not a second object.
 */
export function countInlineStyles(file: string, src: string): number {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    let count = 0;
    const countIn = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
            count += 1;
            return;
        }
        ts.forEachChild(node, countIn);
    };
    const visit = (node: ts.Node): void => {
        if (ts.isJsxAttribute(node) && /style$/i.test(node.name.getText(sf)) && node.initializer) {
            countIn(node.initializer);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return count;
}

function* sourceFiles(dir: string): Generator<string> {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) yield* sourceFiles(p);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) yield p;
    }
}

describe('the measurement', () => {
    // Without these, an empty budget would pass whatever the Linter did.
    it('reads a file over the line limit at its size', () => {
        const src = Array.from({ length: 301 }, (_, i) => `export const v${i} = ${i};`).join('\n');
        expect(measure('src/x.ts', src, ['max-lines']).get('max-lines')).toBe(301);
    });

    it('reads function length, parameters and complexity', () => {
        const body = Array.from({ length: 81 }, (_, i) => `    if (a === ${i}) b += ${i};`).join('\n');
        const src = `export function f(a: number, b: number, c: number, d: number, e: number) {\n${body}\n    return b + c + d + e;\n}`;
        const found = measure('src/x.ts', src, ['max-lines-per-function', 'max-params', 'complexity']);
        expect(Object.fromEntries(found)).toEqual({ 'max-lines-per-function': 84, 'max-params': 5, complexity: 82 });
    });

    it('reports nothing for a file inside every limit', () => {
        expect(measure('app/x.tsx', 'export const x = 1;\n', quality.RULES).size).toBe(0);
    });

    it('counts an inline style object wherever a style prop holds one', () => {
        const src = [
            'const a = <View style={{ flex: 1 }} />;',
            'const b = <View style={[styles.row, { gap: 4 }, on ? { opacity: 1 } : null]} />;',
            'const c = <FlatList contentContainerStyle={{ padding: 8 }} />;',
            'const d = <Pressable style={({ pressed }) => [styles.row, { opacity: pressed ? 0.5 : 1 }]} />;',
            'const e = <View style={{ transform: [{ rotate: "90deg" }] }} />;',
            'const f = <View style={styles.row} testID="x" />;',
        ].join('\n');
        expect(countInlineStyles('x.tsx', src)).toBe(6);
    });
});

describe('quality-budget.json', () => {
    const entries = Object.entries(quality.budget.files);

    it.each(entries.length ? entries : [['(no budgeted files)', {}] as const])(
        '%s is still over its limits, at exactly the budgeted size',
        (file, budgeted) => {
            if (!entries.length) return;
            const abs = path.join(MOBILE, file);
            expect({ file, exists: fs.existsSync(abs) }).toEqual({ file, exists: true });

            const rules = Object.keys(budgeted);
            const measured = measure(file, fs.readFileSync(abs, 'utf8'), rules);
            // `undefined` = back under the default: delete the rule (or the
            // entry). A smaller number = lower the budget to it.
            const actual = Object.fromEntries(rules.map((rule) => [rule, measured.get(rule)]));
            expect({ file, budget: actual }).toEqual({ file, budget: budgeted });
        },
    );

    it('only budgets the size rules', () => {
        const unknown = entries.flatMap(([file, over]) =>
            Object.keys(over).filter((rule) => !quality.RULES.includes(rule)).map((rule) => `${file}: ${rule}`));
        expect(unknown).toEqual([]);
    });
});

describe('inline style objects', () => {
    it('are counted exactly; the count may only go down', () => {
        let count = 0;
        for (const root of ['app', 'src']) {
            for (const file of sourceFiles(path.join(MOBILE, root))) {
                if (file.endsWith('.tsx')) count += countInlineStyles(file, fs.readFileSync(file, 'utf8'));
            }
        }
        // Higher: move the new object into StyleSheet.create / useThemedStyles.
        // Lower: well done — write the new number into quality-budget.json.
        expect({ inlineStyles: count }).toEqual({ inlineStyles: quality.budget.inlineStyles });
    });
});
