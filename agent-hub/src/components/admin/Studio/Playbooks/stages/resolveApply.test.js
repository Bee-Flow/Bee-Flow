// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { applyResolvePlan, readable, resolveSummary } from './resolveApply';

const t = (k, f, v) => (v ? Object.entries(v).reduce((s, [a, b]) => s.replace(`{${a}}`, String(b)), f) : f);

/**
 * A proposal becomes writes through the endpoints that already own them — and
 * one refused write never costs the others.
 */
describe('resolveApply — an approved fix becomes the smallest set of calls', () => {
    it('sends each kind to the endpoint that owns it, in the order the plan gives', async () => {
        const order = [];
        const deps = {
            register: vi.fn(async () => { order.push('register'); return { written: ['processing_register'], failed: [] }; }),
            saveAutomation: vi.fn(async () => { order.push('automation'); }),
            publish: vi.fn(async () => { order.push('publish'); }),
            assignMember: vi.fn(async () => { order.push('member'); }),
            saveComplianceSettings: vi.fn(async () => { order.push('settings'); }),
        };
        const out = await applyResolvePlan({
            calls: [
                { kind: 'automation_definition', body: { automationId: 'aut_1', definition: { steps: [] } } },
                { kind: 'org_settings', body: { ai_content_marking_enabled: true } },
            ],
        }, deps);
        expect(order).toEqual(['automation', 'settings']);
        expect(deps.saveAutomation).toHaveBeenCalledWith('aut_1', { steps: [] });
        expect(deps.saveComplianceSettings).toHaveBeenCalledWith({ ai_content_marking_enabled: true });
        expect(out).toEqual({ applied: ['automation_definition', 'org_settings'], failed: [], ok: true });
    });

    it('the register route reports partial success instead of throwing — that still counts as failed', async () => {
        const deps = { register: vi.fn(async () => ({ written: ['evidence'], failed: [{ what: 'processing_register', error: 'a retention period needs a date column to count from' }] })) };
        const out = await applyResolvePlan({ calls: [{ kind: 'register', body: { registration: {} } }] }, deps);
        expect(out.ok).toBe(false);
        expect(out.applied).toEqual([]);
        expect(out.failed[0].error).toMatch(/needs a date column/);
        expect(out.failed[0].what).toBe('the processing register');
    });

    it('one refused write never costs the rest, and says which one it was', async () => {
        const forbidden = Object.assign(new Error('nope'), { status: 403 });
        const deps = {
            saveAutomation: vi.fn(async () => {}),
            saveComplianceSettings: vi.fn(async () => { throw forbidden; }),
        };
        const out = await applyResolvePlan({
            calls: [
                { kind: 'automation_definition', body: { automationId: 'a', definition: {} } },
                { kind: 'org_settings', body: {} },
            ],
        }, deps);
        expect(out.applied).toEqual(['automation_definition']);
        expect(out.failed).toEqual([{ what: 'the Compliance Center', kind: 'org_settings', error: 'you do not have the rights for this one' }]);
        expect(resolveSummary(out, t)).toBe('Partly done — the Compliance Center did not go through.');
    });

    it('a kind this page cannot make is refused by name, never silently skipped', async () => {
        const out = await applyResolvePlan({ calls: [{ kind: 'send_a_letter', body: {} }] }, {});
        expect(out.failed[0].error).toMatch(/unknown change "send_a_letter"/);
        // A known kind with no dep wired is the same honesty, different words.
        const missing = await applyResolvePlan({ calls: [{ kind: 'app_publish', body: {} }] }, {});
        expect(missing.failed[0].error).toBe('this page cannot make that change');
        expect(resolveSummary(missing, t)).toMatch(/^Nothing was changed/);
    });

    it('the reasons a person reads are reasons, not status codes', () => {
        expect(readable(Object.assign(new Error('x'), { status: 409 }))).toMatch(/changed it while you were reading/);
        expect(readable(Object.assign(new Error('x'), { status: 422, body: { errors: ['Screen "Dashboard" has no data source'] } }))).toBe('Screen "Dashboard" has no data source');
        expect(readable(new Error('the network went away'))).toBe('the network went away');
    });

    it('an empty plan claims nothing', async () => {
        const out = await applyResolvePlan({ calls: [] }, {});
        expect(out).toEqual({ applied: [], failed: [], ok: false });
        expect(resolveSummary(out, t)).toBe('Done. Reading it again…');
    });
});
