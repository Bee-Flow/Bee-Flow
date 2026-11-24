// The plain words of a plan's try-out and of a run that failed at a step (./coworkWiringModel.ts), in English
// fallbacks: what the owner reads instead of the runner's message.
import { describe, expect, it } from 'vitest';
import { draftFixLine, draftFixOutcome, failureLine, offerDraftFix, triedLines, wiringChangeWords } from './coworkWiringModel';
import { canApprove } from './coworkPlanModel';
import { englishT, supplierRadarDraft } from './coworkPlan.fixture';
import type { PlanState, PlanTried } from '@/api/coworkPlan.types';

const tried = (over: Partial<PlanTried> = {}): PlanTried => ({
    status: 'passed', current: true, required: true, blocksApproval: false, rounds: 1, problems: [],
    summary: { reads: [{ title: 'List meetings', items: 5 }], ai: 1, held: 1 }, ...over,
});

const TITLES: Record<string, string> = { dt_week: 'A week ago', dt_now: 'Now', ff_list: 'List meetings' };
const titleOf = (id: string) => TITLES[id] ?? null;

describe('triedLines', () => {
    it('a passing try-out says what it read and did, and that nothing left', () => {
        expect(triedLines(tried(), englishT)).toEqual({ line: "Tried once: 'List meetings' read 5 items, the AI wrote its answer. Nothing was changed or sent.", problems: [], tone: 'ok' });
        expect(triedLines(tried({ rounds: 2 }), englishT)?.line).toBe("Tried 2 times until it worked: 'List meetings' read 5 items, the AI wrote its answer. Nothing was changed or sent.");
    });

    it('a failed try-out says honestly what still fails', () => {
        const lines = triedLines(tried({ status: 'failed', blocksApproval: true, problems: ["'Get summaries' failed (all_items_failed)."] }), englishT);
        expect(lines).toEqual({ line: 'Tried, and it does not work yet. It cannot be approved until a try-out passes:', problems: ["'Get summaries' failed (all_items_failed)."], tone: 'error' });
    });

    it('a plan that changed since its try-out asks for another one; a hand-made plan without one says nothing', () => {
        expect(triedLines(tried({ current: false, blocksApproval: true }), englishT)?.tone).toBe('warning');
        expect(triedLines(tried({ current: false, required: false }), englishT)).toBeNull();
        expect(triedLines(null, englishT)).toBeNull();
    });
});

describe('canApprove with a try-out', () => {
    const state = (over: Partial<PlanState>): PlanState => ({ automationId: 'a1', draft: supplierRadarDraft(), approved: null, widens: [], upToDate: false, ...over });
    it('waits for a try-out that passes', () => {
        expect(canApprove(state({ tried: tried({ status: 'failed', blocksApproval: true }) }))).toBe(false);
        expect(canApprove(state({ tried: tried() }))).toBe(true);
        expect(canApprove(state({ tried: null }))).toBe(true);
    });
});

describe('failureLine', () => {
    it('a date the step could not read, from the step it reads', () => {
        expect(failureLine({ stepId: 'dt_week', errorClass: 'datetime_unresolved_input', sourceStepId: 'dt_now' }, titleOf, englishT)).toBe("'A week ago' could not read the date from 'Now'.");
    });

    it('a date read from a step that is not in the plan says so', () => {
        expect(failureLine({ stepId: 'dt_week', errorClass: 'datetime_unresolved_input', sourceStepId: 'dt_ac3ed7' }, titleOf, englishT)).toBe("'A week ago' could not read the date: it reads from a step that is not in the plan.");
    });

    it('any other failure names the step, and what it worked with', () => {
        expect(failureLine({ stepId: 'ff_list', errorClass: 'tool_error', sourceStepId: 'dt_week' }, titleOf, englishT)).toBe("'List meetings' could not work with what 'A week ago' gave it.");
        expect(failureLine({ stepId: 'ff_list', errorClass: null, sourceStepId: null }, titleOf, englishT)).toBe("'List meetings' did not work.");
    });

    it('nothing for a run that did not fail at a step, or at a step the plan no longer has', () => {
        expect(failureLine(undefined, titleOf, englishT)).toBeNull();
        expect(failureLine({ stepId: 'gone', errorClass: null, sourceStepId: null }, titleOf, englishT)).toBeNull();
    });
});

describe('the fix of the wiring of a plan that is not approved', () => {
    const WAITS = [{ kind: 'waits' as const, step: 'Notification', other: 'AI step' }];
    const blocked = (over: Partial<PlanState> = {}): PlanState => ({
        automationId: 'a1', draft: { ...supplierRadarDraft(), findings: [{ code: 'wiring.ref_not_upstream', stepId: 'digest', message: 'x' }] },
        approved: null, widens: [], upToDate: false, wiringFixable: true, ...over,
    });

    it('says what was fixed, in the plan\'s titles, only for the plan on screen', () => {
        expect(draftFixLine(tried({ wiringFixed: WAITS }), englishT)).toBe("Fixed: 'Notification' now waits for 'AI step'.");
        expect(draftFixLine(tried({ wiringFixed: WAITS, current: false }), englishT)).toBeNull();
        expect(draftFixLine(tried(), englishT)).toBeNull();
        expect(wiringChangeWords([...WAITS, { kind: 'reads', step: 'A week ago', other: 'Now' }], englishT)).toBe("'Notification' now waits for 'AI step', 'A week ago' now reads from 'Now'");
    });

    it('an untried plan does not repeat its findings when the card shows them, and says the budget when that kept it', () => {
        const untried = tried({ status: 'untried', problems: ['x'] });
        expect(triedLines(untried, englishT, { findingsShown: true })).toEqual({ line: 'Not tried yet.', problems: [], tone: 'warning' });
        expect(triedLines(untried, englishT)?.line).toBe('Not tried yet, because it cannot run as it is:');
        expect(triedLines(tried({ status: 'untried', problems: ['Not tried: the budget.'], wiringFixed: WAITS }), englishT)).toEqual({ line: 'Not tried yet.', problems: ['Not tried: the budget.'], tone: 'warning' });
    });

    it('offers "Fix it for me" where Cowork\'s own attempt did not work out, never while it is under way', () => {
        expect(offerDraftFix(blocked(), { busy: false, failed: false }), 'it is being asked by itself').toBe(false);
        expect(offerDraftFix(blocked(), { busy: false, failed: true })).toBe(true);
        expect(offerDraftFix(blocked({ wiringFixable: false }), { busy: false, failed: false }), 'no fix known: the sentence says why').toBe(true);
        expect(offerDraftFix(blocked(), { busy: true, failed: true })).toBe(false);
        expect(offerDraftFix(blocked({ upToDate: true }), { busy: false, failed: true }), 'the approved plan is not changed here').toBe(false);
        const fixedUntried: PlanState = { ...blocked({ wiringFixable: false }), draft: supplierRadarDraft(), tried: tried({ status: 'untried', wiringFixed: WAITS }) };
        expect(offerDraftFix(fixedUntried, { busy: false, failed: false })).toBe(true);
        expect(offerDraftFix({ ...fixedUntried, tried: tried({ wiringFixed: WAITS }) }, { busy: false, failed: false })).toBe(false);
    });

    it('says how "Fix it for me" went in one sentence', () => {
        expect(draftFixOutcome({ tried: 'running' }, englishT)).toBe('Fixed. It is being tried now, without changing or sending anything.');
        expect(draftFixOutcome({ tried: 'passed' }, englishT)).toBe('Fixed, and its try-out passed.');
        expect(draftFixOutcome({ tried: 'failed' }, englishT)).toBe('Fixed, but its try-out does not pass yet.');
        expect(draftFixOutcome({ tried: 'untried' }, englishT)).toBe('Fixed, but it could not be tried yet.');
    });
});
