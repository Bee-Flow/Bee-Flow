import { describe, it, expect } from 'vitest';
import * as palette from './stepPalette';
import { fitsAfterCards } from './ribbon/fitsAfter';
import { withPlanLocks, PRIVACY_STEPS, APPROVALS } from './planLockModel';

/**
 * The palette offers a step the plan does not include INERT, with the plan's
 * sentence and a lock, rather than as an addable step the server will refuse
 * at Activate (server/automation/licensedSteps.js). Shown, not dropped: a
 * missing entry would answer "can Bee Flow do this?" with silence (BFSF-348).
 * Shortcut rows ("Frequently used", "Suggested next") leave it out instead,
 * because one of them ignores a disabled stamp.
 */

const PRIVACY_REASON = 'Privacy Shield steps are part of the Enterprise plan.';
const APPROVAL_REASON = 'Approvals are part of the Enterprise plan.';
const base = { apps: [], steps: [], flags: { code: true } };
const locked = (caps: string[]) => withPlanLocks(base, Object.fromEntries(caps.map(c => [c, c === APPROVALS ? APPROVAL_REASON : PRIVACY_REASON])));

type Item = { id: string; payload: { kind: string }; disabled?: boolean; disabledReason?: string; planLocked?: boolean };
type Group = { key: string; sections?: Array<{ key: string; items: Item[] }> };

// stepPalette.js is plain JS whose `= null` defaults read as `null` to
// TypeScript (fitsAfter.ts says the same), so its entry points are typed here.
const buildStepGroups = palette.buildStepGroups as unknown as (opts: Record<string, unknown>) => Group[];
const buildSearchResults = palette.buildSearchResults as unknown as (q: string, opts: Record<string, unknown>) => Item[];
const itemForKey = palette.itemForKey as unknown as (key: string, opts: Record<string, unknown>) => Item | null;
const gated = palette.gated as unknown as (item: object, hasFormTrigger: boolean | null, catalog?: unknown) => Item;

function flowItem(catalog: unknown, section: string, id: string): Item | undefined {
    const groups = buildStepGroups({ catalog });
    return groups.find(g => g.key === 'flow')?.sections?.find(s => s.key === section)?.items.find(i => i.id === id);
}

describe('stepPalette: steps the plan does not include', () => {
    it('without locks both steps are plainly addable', () => {
        const shield = flowItem(base, 'flow_control', 'privacy_shield');
        const approval = flowItem(base, 'people', 'approval');
        expect(shield?.disabled).toBeUndefined();
        expect(approval?.disabled).toBeUndefined();
    });

    it('the Privacy Shield entry is inert with the plan\'s reason and a lock', () => {
        const shield = flowItem(locked([PRIVACY_STEPS]), 'flow_control', 'privacy_shield');
        expect(shield).toMatchObject({ disabled: true, disabledReason: PRIVACY_REASON, planLocked: true });
        expect(flowItem(locked([PRIVACY_STEPS]), 'people', 'approval')?.disabled).toBeUndefined();
    });

    it('the approval step is inert when approvals are not in the plan', () => {
        const approval = flowItem(locked([APPROVALS]), 'people', 'approval');
        expect(approval).toMatchObject({ disabled: true, disabledReason: APPROVAL_REASON, planLocked: true });
    });

    it('search finds them, inert and locked, instead of not at all', () => {
        const catalog = locked([PRIVACY_STEPS, APPROVALS]);
        const privacy = buildSearchResults('tokenize', { catalog }).find(r => r.payload.kind === 'guard');
        expect(privacy).toMatchObject({ disabled: true, planLocked: true, disabledReason: PRIVACY_REASON });
        const approval = buildSearchResults('approval', { catalog }).find(r => r.payload.kind === 'approval');
        expect(approval).toMatchObject({ disabled: true, planLocked: true });
    });

    it('the shortcut rows leave a locked step out, and keep it when the plan has it', () => {
        const catalog = locked([PRIVACY_STEPS, APPROVALS]);
        for (const key of ['step:guard', 'step:tokenize', 'step:untokenize', 'step:approval']) {
            expect(itemForKey(key, { catalog })).toBeNull();
            expect(itemForKey(key, { catalog: base })).not.toBeNull();
        }
    });

    it('the plan wins over the form-trigger rule, which still applies on its own', () => {
        const formPage = { id: 'form_page', payload: { kind: 'form_page' } };
        expect(gated(formPage, false, locked([PRIVACY_STEPS]))).toMatchObject({ disabled: true });
        expect(gated(formPage, false, locked([PRIVACY_STEPS])).planLocked).toBeUndefined();
        const approval = { id: 'approval', payload: { kind: 'approval' } };
        expect(gated(approval, true, null)).toBe(approval);
    });

    it('the "Ask for approval" card after a trigger is inert too', () => {
        const trigger = { id: 't1', type: 'trigger', kind: 'manual' };
        const approve = (catalog: unknown) => fitsAfterCards(trigger, catalog as never).find(c => c.id.endsWith(':approve'));
        expect(approve(base)?.disabled).toBeUndefined();
        expect(approve(locked([APPROVALS]))).toMatchObject({ disabled: true, disabledReason: APPROVAL_REASON });
    });
});
