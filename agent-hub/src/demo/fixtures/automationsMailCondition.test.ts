// @vitest-environment node
/**
 * The two "Fabrikam attachments" demo automations tell the truth about the
 * engine: what they recorded is what the shared expression engine (the one
 * the runner uses) gives on the same mails, and the BEFORE automation has the
 * defect the Condition fix is about (spec section 8).
 *
 * Run: cd agent-hub && npx vitest run src/demo/fixtures/automationsMailCondition.test.ts
 */
import { describe, it, expect } from 'vitest';
import { evaluate, getList, parseExpr } from '@shared/expr/index.mjs';
import { staleSuccessors } from '@shared/expr/routeFollow.mjs';
import {
    CONDITION_EXPR,
    MAIL_CONDITION_STEP_RESULTS,
    MAIL_SPLIT_STEP_RESULTS,
    SPLIT_CASES,
    mailConditionDefinition,
    mailSplitDefinition,
} from './automationsMailCondition';

type Json = Record<string, any>;

const conditionOut = MAIL_CONDITION_STEP_RESULTS.mc_condition.output as Json;
const splitOut = MAIL_SPLIT_STEP_RESULTS.ms_split.output as Json;
const stepsOf = (def: Json) => def.steps as Json[];

/** Keep the items a rule matches, with the runner's scope `{ ...root, item, _index }`. */
function keep(expr: string, items: unknown[], root: Json): unknown[] {
    const ast = parseExpr(expr);
    return items.filter((item, _index) => !!evaluate(ast, { ...root, item, _index }));
}

describe('mail Condition demo (BEFORE): a filter on the mails', () => {
    const root = { steps: { mc_read_many: { output: MAIL_CONDITION_STEP_RESULTS.mc_read_many.output } } };
    const condition = stepsOf(mailConditionDefinition()).find(s => s.id === 'mc_condition')!;

    it('recorded exactly what the shared engine keeps with that rule: 3 of 4 mails', () => {
        expect(condition.expr).toBe(CONDITION_EXPR);
        const mails = getList(root, condition.arrayRef) as unknown[];
        expect(mails).toHaveLength(4);
        const kept = keep(CONDITION_EXPR, mails, root);
        expect(kept).toHaveLength(3);
        expect(conditionOut.items).toEqual(kept);
        expect([conditionOut.count, conditionOut.inputCount, conditionOut.rejectedCount]).toEqual([3, 4, 1]);
    });

    it('"Read attachment" still reads Read many, so staleSuccessors names it', () => {
        expect(staleSuccessors(mailConditionDefinition(), 'mc_condition').map((s: Json) => s.stepId)).toEqual(['mc_read_attachment']);
    });
});

describe('mail split demo (AFTER): a list switch on the attachments', () => {
    const root = { steps: { ms_read_many: { output: MAIL_SPLIT_STEP_RESULTS.ms_read_many.output } } };
    const split = stepsOf(mailSplitDefinition()).find(s => s.id === 'ms_split')!;

    it('recorded per output what equals(fileType(item), …) matches on every attachment', () => {
        const attachments = getList(root, split.arrayRef) as unknown[];
        expect(attachments).toHaveLength(11);
        for (const c of split.cases as Json[]) {
            expect(c.expr).toBe(`equals(fileType(item), "${c.name}")`);
            const matched = keep(c.expr, attachments, root);
            expect(splitOut.matchesByCase[c.name]).toEqual(matched);
            expect(splitOut.counts[c.name]).toBe(matched.length);
        }
        expect(splitOut.counts).toEqual({ pdf: 4, word: 2, powerpoint: 1, default: 4 });
        expect(splitOut.total).toBe(11);
        expect((split.cases as Json[]).map(c => c.name)).toEqual([...SPLIT_CASES]);
        expect(split.routeStyle).toBe('rules');
    });

    it('"Read attachment" hangs off the pdf output and reads it: nothing stale, 4 reads', () => {
        const def = mailSplitDefinition();
        expect(staleSuccessors(def, 'ms_split')).toEqual([]);
        const read = stepsOf(def).find(s => s.id === 'ms_read_attachment')!;
        expect(read.forEach.overRef).toBe('steps.ms_split.output.matchesByCase.pdf');
        expect((def.edges as Json[]).find(e => e.to === 'ms_read_attachment')).toMatchObject({ from: 'ms_split', label: 'case:pdf' });
        const out = MAIL_SPLIT_STEP_RESULTS.ms_read_attachment.output as Json;
        expect([out.iterations, out.succeeded, out.failed]).toEqual([4, 4, 0]);
    });

    it('uses only reserved example domains', () => {
        const text = JSON.stringify([MAIL_SPLIT_STEP_RESULTS, mailSplitDefinition()]);
        const domains = new Set(text.match(/@[a-z0-9.-]+/gi) ?? []);
        for (const d of domains) expect(d).toMatch(/\.example$/);
    });
});
