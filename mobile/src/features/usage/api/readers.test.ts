/**
 * The usage readers keep what the screens read exactly as the server sent it —
 * a Postgres count stays the string it arrived as, for num() to coerce — and
 * turn a missing field into a stated default instead of an undefined.
 */

import {
    readConsumerUsage,
    readCostTimeline,
    readLicenseStatus,
    readModelUsage,
    readUsageSummary,
} from './readers';

describe('readUsageSummary', () => {
    it('keeps aggregates as they arrived, numbers or numeric strings', () => {
        const summary = readUsageSummary({
            total_calls: '1423',
            total_tokens: 90210,
            total_prompt_tokens: '1',
            total_completion_tokens: '2',
            total_estimated_cost: '18.4402',
            combined_total_cost: 20.5,
            extra: 'ignored',
        });
        expect(summary).toEqual({
            total_calls: '1423',
            total_tokens: 90210,
            total_prompt_tokens: '1',
            total_completion_tokens: '2',
            total_cached_tokens: undefined,
            total_estimated_cost: '18.4402',
            total_input_cost: undefined,
            total_output_cost: undefined,
            azure_services_total_cost: undefined,
            combined_total_cost: 20.5,
            unique_models: undefined,
            unique_users: undefined,
            avg_duration_ms: undefined,
        });
    });

    it('reads a missing required aggregate as 0 and a non-object as null', () => {
        expect(readUsageSummary({})?.total_calls).toBe(0);
        expect(readUsageSummary(null)).toBeNull();
    });
});

describe('the list readers', () => {
    it('read rows, and anything that is not a list as none', () => {
        expect(readCostTimeline([{ period: '2026-03-02', total_cost: '1.5' }])[0]).toMatchObject({
            period: '2026-03-02',
            total_cost: '1.5',
            calls: 0,
        });
        expect(readCostTimeline(null)).toEqual([]);
        expect(readModelUsage({ rows: [] })).toEqual([]);
    });
});

describe('readLicenseStatus', () => {
    it('reads the licence and defaults to Community', () => {
        const status = readLicenseStatus({
            tier: 'enterprise',
            source: 'license_key',
            license: { id: 'l1', tier: 'enterprise', expiresAt: '2027-01-01' },
            subscription: null,
            features: ['a', 3],
            limits: { seats: 10 },
        });
        expect(status?.tier).toBe('enterprise');
        expect(status?.license?.expiresAt).toBe('2027-01-01');
        expect(status?.features).toEqual(['a']);
        expect(readLicenseStatus({})?.tier).toBe('community');
        expect(readLicenseStatus('nope')).toBeNull();
    });
});

describe('readConsumerUsage', () => {
    it('keeps a null cap as "no limit" and defaults the plan the way the server does', () => {
        const plan = readConsumerUsage({
            limits: { max_cost_per_month: null, max_messages_per_month: 500 },
            usage: { total_billed_cost: 3.2, by_type: [{ agent_type: 'chat', billed_cost: '1' }] },
        });
        expect(plan?.limits.max_cost_per_month).toBeNull();
        expect(plan?.limits.max_messages_per_month).toBe(500);
        expect(plan?.limits.plan_name).toBe('Free');
        expect(plan?.billing_model).toBe('fixed');
        expect(plan?.usage.by_type).toEqual([{ agent_type: 'chat', billed_cost: '1' }]);
        expect(plan?.subscription).toBeNull();
    });
});
