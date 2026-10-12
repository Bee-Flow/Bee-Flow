// @vitest-environment node
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseExprToRows, serializeRows } from '../../utils/conditionModel';

/**
 * A3: every rule shape the AI builders are taught (server
 * builderTools/ruleExamples.js) opens in the Condition editor as clickable
 * rows, never as a formula, and writes back unchanged.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_PATH = path.resolve(here, '../../../../../../../server/automation/builderTools/ruleExamples.js');
const require_ = createRequire(import.meta.url);
const { CONDITION_RULE_EXAMPLES, SWITCH_RULES_EXAMPLE } = require_(EXAMPLES_PATH) as {
    CONDITION_RULE_EXAMPLES: string[];
    SWITCH_RULES_EXAMPLE: { cases: Array<{ name: string; expr: string }> };
};

type Parsed = { rows: unknown[]; join: string } | null;

// The switch example builder_add_switch shows the model is taught too.
const ALL_EXAMPLES = [...CONDITION_RULE_EXAMPLES, ...SWITCH_RULES_EXAMPLE.cases.map((c) => c.expr)];

describe('CONDITION_RULE_EXAMPLES and SWITCH_RULES_EXAMPLE open as rows', () => {
    it('loads the examples the builders are taught', () => {
        expect(CONDITION_RULE_EXAMPLES.length).toBeGreaterThan(10);
        expect(SWITCH_RULES_EXAMPLE.cases.length).toBeGreaterThan(1);
    });

    it.each(ALL_EXAMPLES)('%s parses to rows and writes back unchanged', (expr) => {
        const parsed = parseExprToRows(expr) as Parsed;
        expect(parsed).not.toBeNull();
        expect(parsed!.rows.length).toBeGreaterThan(0);
        expect(serializeRows(parsed!.rows, parsed!.join)).toBe(expr);
    });
});
