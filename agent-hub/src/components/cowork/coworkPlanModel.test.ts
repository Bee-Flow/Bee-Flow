/**
 * What the plan card says, worked out from the plan the server sent (./coworkPlanModel.ts).
 */
import { describe, it, expect } from 'vitest';
import { appLabel, appsByEffect, canApprove, canReplay, canTry, makeUpParts, planStatusOf } from './coworkPlanModel';
import { planState, supplierRadarDraft } from './coworkPlan.fixture';

describe('where a plan stands', () => {
    it('an item without a plan has none', () => {
        expect(planStatusOf(planState({ automationId: null, draft: null }))).toBe('none');
    });

    it('a named automation that is gone leaves nothing to show', () => {
        expect(planStatusOf(planState({ draft: null }))).toBe('gone');
    });

    it('a plan with a finding is blocked when nothing else runs: never approved, or the approved plan is this one', () => {
        const draft = { ...supplierRadarDraft(), findings: [{ code: 'step.not_allowed', stepId: 'c', message: 'A plan cannot run a script yet.' }] };
        expect(planStatusOf(planState({ draft }))).toBe('blocked');
        expect(planStatusOf(planState({ draft, approved: { version: 1, fingerprint: draft.fingerprint, approvedAt: null, permissions: draft.permissions }, upToDate: true }))).toBe('blocked');
    });

    it('a plan nobody approved is waiting for its first approval', () => {
        expect(planStatusOf(planState())).toBe('first');
    });

    it('the approved plan is approved, and a different one has changed', () => {
        const draft = supplierRadarDraft();
        const approved = { version: 2, fingerprint: draft.fingerprint, approvedAt: '2026-11-23T09:14:00.000Z', permissions: draft.permissions };
        expect(planStatusOf(planState({ approved, upToDate: true }))).toBe('approved');
        expect(planStatusOf(planState({ approved: { ...approved, fingerprint: 'older' }, upToDate: false }))).toBe('changed');
    });
});

describe('what can be approved', () => {
    it('a first plan and a changed plan can; an approved, a blocked and a missing one cannot', () => {
        const draft = supplierRadarDraft();
        const approved = { version: 1, fingerprint: draft.fingerprint, approvedAt: null, permissions: draft.permissions };
        expect(canApprove(planState())).toBe(true);
        expect(canApprove(planState({ approved: { ...approved, fingerprint: 'older' } }))).toBe(true);
        expect(canApprove(planState({ approved, upToDate: true }))).toBe(false);
        expect(canApprove(planState({ draft: { ...draft, findings: [{ code: 'x', stepId: null, message: 'No.' }] } }))).toBe(false);
        // Trying is open to every plan nothing blocks: the approved one can be tried again.
        expect(canTry(planState())).toBe(true);
        expect(canTry(planState({ approved, upToDate: true }))).toBe(true);
        expect(canTry(planState({ draft: { ...draft, findings: [{ code: 'x', stepId: null, message: 'No.' }] } }))).toBe(false);
        expect(canTry(planState({ draft: null }))).toBe(false);
        expect(canTry(planState({ automationId: null, draft: null }))).toBe(false);
        expect(canApprove(planState({ draft: null }))).toBe(false);
        expect(canApprove(planState({ automationId: null, draft: null }))).toBe(false);
    });

    it('only a changed plan nothing blocks can be replayed on the past runs', () => {
        const draft = supplierRadarDraft();
        const approved = { version: 1, fingerprint: draft.fingerprint, approvedAt: null, permissions: draft.permissions };
        expect(canReplay(planState({ approved: { ...approved, fingerprint: 'older' } }))).toBe(true);
        expect(canReplay(planState())).toBe(false);
        expect(canReplay(planState({ approved, upToDate: true }))).toBe(false);
        expect(canReplay(planState({ approved: { ...approved, fingerprint: 'older' }, draft: { ...draft, findings: [{ code: 'x', stepId: null, message: 'No.' }] } }))).toBe(false);
    });
});

describe('the count behind "4 fixed, 2 AI"', () => {
    it('lists the kinds that have steps, fixed first', () => {
        expect(makeUpParts({ fixed: 4, ai: 2, ask: 0, deliver: 1 })).toEqual([
            { kind: 'fixed', count: 4 }, { kind: 'ai', count: 2 }, { kind: 'deliver', count: 1 },
        ]);
    });

    it('is empty for a plan without steps, and for no plan at all', () => {
        expect(makeUpParts({ fixed: 0, ai: 0, ask: 0, deliver: 0 })).toEqual([]);
        expect(makeUpParts(null)).toEqual([]);
    });
});

describe('the apps a plan touches', () => {
    it('reads an app id as a name', () => {
        expect(appLabel('outlook')).toBe('Outlook');
        expect(appLabel('google-drive')).toBe('Google drive');
        expect(appLabel('bee_flow')).toBe('Bee flow');
    });

    it('groups them by what the plan does there, each app once, in alphabetical order', () => {
        expect(appsByEffect(supplierRadarDraft().permissions)).toEqual({ reads: ['Outlook'], writes: ['Datatables', 'Outlook'], sends: [] });
        expect(appsByEffect({
            v: 1, sends: 'others', ai: false, outsideText: false,
            grants: [
                { app: 'outlook', effect: 'reads', tools: ['outlook_read'] },
                { app: 'gmail', effect: 'reads', tools: ['gmail_read'] },
                { app: 'outlook', effect: 'sends', tools: ['outlook_compose'] },
            ],
        })).toEqual({ reads: ['Gmail', 'Outlook'], writes: [], sends: ['Outlook'] });
    });

    it('is empty without permissions', () => {
        expect(appsByEffect(null)).toEqual({ reads: [], writes: [], sends: [] });
    });
});

describe('a change with findings while an approved plan runs', () => {
    it('reads as changed, not blocked: runs still follow the approved version; it cannot be approved or tried', () => {
        const draft = supplierRadarDraft();
        const approved = { version: 2, fingerprint: 'older', approvedAt: null, permissions: draft.permissions };
        const state = planState({ approved, upToDate: false, draft: { ...draft, findings: [{ code: 'step.not_allowed', stepId: 'c', message: 'A plan cannot run a script yet.' }] } });
        expect(planStatusOf(state)).toBe('changed');
        expect(canApprove(state)).toBe(false);
        expect(canTry(state)).toBe(false);
        expect(planStatusOf({ ...state, approved: null })).toBe('blocked');
    });
});
