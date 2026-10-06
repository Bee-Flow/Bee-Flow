// @vitest-environment node
/**
 * The two flatten demo automations tell the truth about the engine (spec
 * section 8): what they recorded is what the shared engine (the one the
 * runner uses) makes from the same data, the stored plans are the plans
 * auto-map writes, and the Filter after the flatten counts in attachments.
 *
 * Run: cd agent-hub && npx vitest run src/demo/fixtures/automationsMailFlatten.test.ts
 */
import { describe, expect, it } from 'vitest';
import { evaluate, parseExpr } from '@shared/expr/index.mjs';
import { flattenPlan, flattenRows, listNounKey } from '@shared/expr/flatten.mjs';
import { followRouteAround } from '@shared/expr/routeFollow.mjs';
import {
    FILTER_EXPR, MAIL_FLATTEN_ROUTE, MAIL_FLATTEN_STEP, MAIL_FLATTEN_STEP_RESULTS, ORDERS_FLATTEN_ROUTE, ORDERS_FLATTEN_STEP,
    ORDERS_FLATTEN_STEP_RESULTS, mailFlattenDefinition, ordersFlattenDefinition,
} from './automationsMailFlatten';

type Json = Record<string, any>;

const mailRoot = { steps: { mf_read_many: { output: MAIL_FLATTEN_STEP_RESULTS.mf_read_many.output } } };
const ordersRoot = { steps: { of_http: { output: ORDERS_FLATTEN_STEP_RESULTS.of_http.output } } };
const envelope = (out: Json | null) => {
    const { dead: _d, over: _o, ...rest } = out || {};
    return rest;
};
const stepOf = (def: Json, id: string) => (def.steps as Json[]).find(s => s.id === id)!;

describe('mail flatten demo', () => {
    it('recorded exactly the rows the shared engine makes: 64 from 4 mails', () => {
        const out = MAIL_FLATTEN_STEP_RESULTS.mf_flatten.output as Json;
        expect(out).toEqual(envelope(flattenRows(mailRoot, stepOf(mailFlattenDefinition(), 'mf_flatten'))));
        expect([out.count, out.inputCount, out.emptyCount]).toEqual([64, 4, 0]);
    });

    it('stores the plan auto-map writes from that sample', () => {
        expect(MAIL_FLATTEN_STEP.parents).toEqual(flattenPlan(mailRoot, MAIL_FLATTEN_ROUTE).parents);
    });

    it('left out the long body: every mail body is over 1000 characters', () => {
        const mails = (MAIL_FLATTEN_STEP_RESULTS.mf_read_many.output as Json).messages as Json[];
        for (const m of mails) expect(m.body.length).toBeGreaterThan(1000);
        expect(flattenPlan(mailRoot, MAIL_FLATTEN_ROUTE).left).toContainEqual({ level: 0, key: 'body', reason: 'long_text' });
    });

    it('the Filter kept what its rule keeps per row: 8 of 64', () => {
        const rows = (MAIL_FLATTEN_STEP_RESULTS.mf_flatten.output as Json).items as unknown[];
        const ast = parseExpr(FILTER_EXPR);
        const kept = rows.filter((item, _index) => !!evaluate(ast, { ...mailRoot, item, _index }));
        const out = MAIL_FLATTEN_STEP_RESULTS.mf_filter.output as Json;
        expect(out.items).toEqual(kept);
        expect([out.count, out.inputCount, out.rejectedCount]).toEqual([8, 64, 56]);
        expect((MAIL_FLATTEN_STEP_RESULTS.mf_read_file.output as Json).iterations).toBe(8);
    });

    it('names the Filter\'s rows "attachments" (listNounKey through filter → flatten)', () => {
        expect(listNounKey(mailFlattenDefinition(), 'steps.mf_filter.output.items')).toBe('attachments');
    });

    it('F48: a Filter inserted after the flatten re-points the step after it', () => {
        const def = mailFlattenDefinition() as Json;
        const steps = (def.steps as Json[]).filter(s => s.id !== 'mf_filter');
        const reader = steps.find(s => s.id === 'mf_read_file')!;
        reader.forEach = { ...reader.forEach, overRef: 'steps.mf_flatten.output.items' };
        const filter = { id: 'f_new', type: 'filter', label: 'Filter a list', arrayRef: 'steps.mf_flatten.output.items', expr: 'true' };
        const edges = [
            ...(def.edges as Json[]).filter(e => e.from !== 'mf_filter' && e.to !== 'mf_filter'),
            { from: 'mf_flatten', to: 'f_new' }, { from: 'f_new', to: 'mf_read_file' },
        ];
        const { definition } = followRouteAround({ ...def, steps: [...steps, filter], edges }, 'f_new');
        expect(stepOf(definition, 'mf_read_file').forEach.overRef).toBe('steps.f_new.output.items');
    });
});

describe('orders flatten demo', () => {
    it('recorded the rows with Keep it anyway: 9 from 5 orders, one without line details', () => {
        const out = ORDERS_FLATTEN_STEP_RESULTS.of_flatten.output as Json;
        expect(out).toEqual(envelope(flattenRows(ordersRoot, stepOf(ordersFlattenDefinition(), 'of_flatten'))));
        expect([out.count, out.inputCount, out.emptyCount]).toEqual([9, 5, 1]);
        const empty = (out.items as Json[]).find(r => r.number === 'CO-2026-0413')!;
        expect([empty.id, empty.sku, empty.orderId]).toEqual([null, null, 'ord_413']);
    });

    it('stores the plan auto-map writes from that sample', () => {
        expect(ORDERS_FLATTEN_STEP.parents).toEqual(flattenPlan(ordersRoot, ORDERS_FLATTEN_ROUTE).parents);
    });
});

describe('flatten demos: wired into the Automations demo', () => {
    it('every seeded run has its own id, so each flatten demo hydrates its own recorded run', async () => {
        const { createState, ROUTES } = await import('./automations');
        const state = createState();
        const ids = (state.runs as Json[]).map(r => r.id);
        expect(ids.length).toBe(new Set(ids).size);
        const route = (ROUTES as Json)['GET /api/automation/runs/:runId/steps'];
        const { steps } = route({ state, params: { runId: 'run_demo_mflat_01' } });
        expect((steps as Json[]).map(r => r.stepId)).toEqual(['trg', 'mf_find', 'mf_read_many', 'mf_flatten', 'mf_filter', 'mf_read_file']);
    });
});
