/**
 * The usage reports' server contract, pinned against the server's own source
 * (read as text, like core/api/serverContract.test.ts): every route, the
 * query keys this feature sends to each (two of the three schemas are
 * strict) and the columns the readers read. Red means the server changed:
 * port the change, don't loosen the pin.
 */

import fs from 'node:fs';
import path from 'node:path';

import { BREAKDOWN_PATHS } from './endpoints';

const SERVER = path.resolve(__dirname, '../../../../../server');
const read = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const usage = read('routes/usage.js');
const usageStore = read('stores/usageStore.js');
const azureStore = read('stores/azureServiceUsageStore.js');
const feedback = read('routes/feedback.js');
const feedbackStore = read('stores/feedbackStore.js');
const terminations = read('routes/terminations.js');
const terminationStore = read('stores/terminationStore.js');

function expectAll(source: string, needles: readonly string[]): void {
    expect(needles.filter((n) => !source.includes(n))).toEqual([]);
}

describe('routes/usage.js', () => {
    it('serves every report this feature reads', () => {
        const paths = [...Object.values(BREAKDOWN_PATHS), '/api/usage/summary', '/api/usage/timeline', '/api/usage/azure-services/summary'];
        for (const p of paths) expect(usage).toContain(`router.get('${p.replace('/api/usage', '')}'`);
    });

    it('accepts the query keys usageQuery sends, and redacts the way the reader expects', () => {
        expectAll(usage, [
            'days: wholeNumber(',
            'startDate: aDate.optional()',
            'endDate: aDate.optional()',
            "interval: choice(['hour', 'day']",
            "Send startDate and endDate together, or neither.",
            'out.billed_cost = rawCost * factor',
            "'total_calls'",
            'combined_total_cost:',
            'azure_services_total_cost,',
            'display_name: info?.display_name',
        ]);
    });

    it('returns the columns the readers read', () => {
        expectAll(usageStore, [
            'as total_calls', 'as total_tokens', 'as total_estimated_cost', 'as unique_users',
            'as period', 'as calls', 'as estimated_cost', 'SELECT source, COUNT(*) as calls', 'SELECT user_id, COUNT(*) as calls',
            "COALESCE(agent_name, 'Direct Chat') as agent_name",
        ]);
        expectAll(azureStore, ['as total_cost', 'GROUP BY service_type']);
    });
});

describe('routes/feedback.js', () => {
    it('serves the org routes behind the org-admin and licence gates, with a strict window query', () => {
        expectAll(feedback, [
            "router.get('/org', requireOwnOrgAdmin, requireAdvancedMonitoring, validate({ query: ListQuery })",
            "router.get('/org/summary', requireOwnOrgAdmin, requireAdvancedMonitoring, validate({ query: RangeQuery })",
            "const RangeQuery = z.object({ startDate: moment('startDate'), endDate: moment('endDate') }).strict();",
        ]);
        expectAll(feedbackStore, [
            'as thumbs_up', 'as thumbs_down', 'as with_comments', 'COUNT(*) as total',
            "rating TEXT NOT NULL CHECK(rating IN ('up', 'down'))", 'conversation_snapshot TEXT', 'agent_name TEXT',
        ]);
    });
});

describe('routes/terminations.js', () => {
    it('serves the org routes with the keys this feature sends', () => {
        expectAll(terminations, [
            "router.get('/org', requireOwnOrgAdminScope, readQuery",
            "router.get('/org/summary', requireOwnOrgAdminScope, readQuery",
            "router.get('/org/timeline', requireOwnOrgAdminScope, readQuery",
            "router.get('/org/by-agent', requireOwnOrgAdminScope, readQuery",
            'startDate: when(', 'endDate: when(', "interval: z.enum(['hour', 'day']", 'limit: z.coerce.number(',
            'res.json({ rows })', 'res.json({ rows, interval })',
        ]);
        expectAll(terminationStore, [
            'return { total, by_type }', 'AS period', 'termination_type', 'AS count', 'AS errors',
            'error_code TEXT', 'error_first_line TEXT', 'agent_name TEXT',
        ]);
    });
});
