/**
 * The semantic handoff, as data.
 *
 * What is pinned here is the promise the offer makes to the author: accept it
 * and you get a step that answers your question in one word, plus outputs
 * that read that word — nothing invented, nothing that resolves to nothing.
 * Each of these is a bug that would be invisible on screen and silent at run
 * time:
 *
 *   1. THE PATH RESOLVES. A rule naming a path nothing writes parses
 *      perfectly and matches nothing forever. That is the exact failure the
 *      server route refuses to create (routeRules.js verifyRouteRules), so
 *      creating it here through the back door would be worse than having no
 *      offer at all.
 *   2. THE FIELD IS DECLARED. The path only resolves because the inserted
 *      step declares the field it writes; without the schema the step answers
 *      in prose and every rule reads undefined.
 *   3. IT READS BACK AS A SENTENCE. Every other suggestion in this box is
 *      checked as words, not syntax, so these expressions must go through the
 *      same parser the canvas describer uses.
 *
 * Run: cd agent-hub && npx vitest run src/components/automation/Builder/flow/settings/routeHandoff.test.js
 */

import { describe, it, expect } from 'vitest';
import { planRouteHandoff, parseCategories, newHandoffStepId, insertStepBefore } from './routeHandoff';
import { parseExprToRows } from '../../utils/conditionModel';
import { describeRuleExpr } from '../displayHelpers';

const QUESTION = 'is this e-mail about a complaint?';

function plan(extra = {}) {
    return planRouteHandoff({
        description: QUESTION,
        categories: ['complaint', 'question', 'something else'],
        stepId: 'ai_handoff',
        ...extra,
    });
}

describe('naming the answers', () => {
    it('splits on commas and slashes, and on nothing else', () => {
        // "something else" is ONE answer. A space separator would turn it into
        // two ports and quietly change what the author asked for.
        expect(parseCategories('complaint, question / something else')).toEqual(
            ['complaint', 'question', 'something else'],
        );
    });

    it('drops blanks and repeats — two ports with one name is an unwireable node', () => {
        expect(parseCategories('complaint,, Complaint , question,')).toEqual(['complaint', 'question']);
    });
});

describe('the step that gets inserted', () => {
    it('declares the field the rules read, as a string', () => {
        const { step, field } = plan();
        expect(step.type).toBe('ai_step');
        expect(step.outputSchema.properties[field]).toMatchObject({ type: 'string' });
        expect(step.outputSchema.required).toEqual([field]);
    });

    it('derives that field from the sentence, through the builder\'s own minting function', () => {
        // Not a second slugifier: slugifyFieldName is what every other
        // author-named binding in this builder is minted with.
        expect(plan().field).toBe('is_this_e_mail_about_a_complaint');
    });

    it('asks for ONE of the named words and nothing else', () => {
        const { step } = plan();
        expect(step.prompt).toContain(QUESTION);
        expect(step.prompt).toContain('- complaint');
        expect(step.prompt).toContain('- something else');
        expect(step.prompt).toMatch(/exactly one of these words, and nothing else/i);
        // An answer outside the list matches no output and falls through with
        // nothing to explain why, so the instruction says so out loud.
        expect(step.prompt).toMatch(/never answer with a word that is not on the list/i);
    });

    it('carries a label a person can read on a card', () => {
        expect(plan().step.label).toBe('Classify: is this e-mail about a complaint?');
        const long = plan({ description: 'is this a complaint about something that happened a very long time ago indeed' });
        expect(long.step.label.length).toBeLessThanOrEqual('Classify: '.length + 48);
        expect(long.step.label.endsWith('…')).toBe(true);
    });

    it('does not guess where the record comes from when the node decides about the whole run', () => {
        // Only the shell can see what feeds this node. A guessed binding on
        // the canvas looks configured and reads nothing.
        expect(plan().step.inputs).toEqual({});
    });
});

describe('the rules that read it', () => {
    it('is one equals-comparison per answer, against the new step\'s output', () => {
        const { rules } = plan();
        expect(rules).toEqual([
            { name: 'complaint', expr: 'steps.ai_handoff.output.is_this_e_mail_about_a_complaint == "complaint"' },
            { name: 'question', expr: 'steps.ai_handoff.output.is_this_e_mail_about_a_complaint == "question"' },
            { name: 'something_else', expr: 'steps.ai_handoff.output.is_this_e_mail_about_a_complaint == "something else"' },
        ]);
    });

    it('READS BACK AS A SENTENCE through the same describer the canvas uses', () => {
        const { rules } = plan();
        // Not "expression-shaped text that happens to work": the clickable
        // model has to recognise it, or the preview shows raw syntax and the
        // Advanced row cannot open it.
        for (const r of rules) expect(parseExprToRows(r.expr)).toBeTruthy();
        expect(describeRuleExpr(rules[0].expr))
            // "mail" is in the describer's proper-noun table, which is why
            // the humanised name is not simply the slug with spaces in it.
            .toBe('Is this e Mail about a complaint equals “complaint”');
    });

    it('names every port uniquely even when two answers slug the same', () => {
        const { rules } = plan({ categories: ['on hold', 'on-hold', 'done'] });
        expect(rules.map(r => r.name)).toEqual(['on_hold', 'on_hold_2', 'done']);
    });

    it('caps the number of outputs — past that it is a lookup table, not a route', () => {
        const many = plan({ categories: ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8', 'i9', 'j10'] });
        expect(many.rules).toHaveLength(8);
    });
});

describe('a Condition that works through a list', () => {
    const perItem = { perItem: true, sourceRef: 'steps.gmail.output.messages' };

    it('runs the new step ONCE PER ITEM over the list the Condition already reads', () => {
        // One answer for the whole run would give every item the same output:
        // a router that looks like it sorts and sorts nothing.
        const { step } = plan(perItem);
        expect(step.forEach).toEqual({ overRef: 'steps.gmail.output.messages', itemVar: 'item' });
        expect(step.inputs).toEqual({ record: { kind: 'ref', path: 'loop.item' } });
    });

    it('points the rules at the per-item answer, and re-points the Condition at the results', () => {
        const { rules, fieldPath, source } = plan(perItem);
        expect(fieldPath).toBe('item.output.is_this_e_mail_about_a_complaint');
        expect(rules[0].expr).toBe('item.output.is_this_e_mail_about_a_complaint == "complaint"');
        // Without this re-point the rules above name a path that resolves to
        // nothing — a forEach step publishes `results`, not the rows.
        expect(source).toBe('steps.ai_handoff.output.results');
    });

    it('follows the editor\'s own name for the row', () => {
        const { rules } = plan({ ...perItem, itemVar: 'row' });
        expect(rules[0].expr.startsWith('row.output.')).toBe(true);
    });

    it('leaves the Condition alone in whole-run mode', () => {
        expect(plan().source).toBeNull();
    });
});

describe('what it refuses to plan', () => {
    it('refuses without a question — the step is built from the author\'s own sentence', () => {
        const out = plan({ description: '   ' });
        expect(out.step).toBeNull();
        expect(out.rules).toEqual([]);
        expect(out.problem).toMatch(/Write the question first/i);
    });

    it('refuses one answer — a single output that always fires is not a decision', () => {
        const out = plan({ categories: ['complaint'] });
        expect(out.step).toBeNull();
        expect(out.problem).toMatch(/at least two possible answers/i);
    });

    it('refuses a per-item plan with no list picked, instead of fanning out over nothing', () => {
        const out = plan({ perItem: true, sourceRef: '' });
        expect(out.step).toBeNull();
        expect(out.problem).toMatch(/no list is picked yet/i);
    });
});

describe('the minted id', () => {
    it('looks like every other ai_step id in the builder', () => {
        expect(newHandoffStepId()).toMatch(/^ai_[a-z0-9]+$/i);
        expect(newHandoffStepId()).not.toBe(newHandoffStepId());
    });
});

/**
 * The other half: the graph edit.
 *
 * Every mistake possible here is invisible on the canvas until a run goes
 * missing. An orphaned Condition still validates, still saves, still draws —
 * it simply has no path from the trigger any more and never runs, and the
 * routine goes on reporting success for the half of itself that still works.
 * So this is asserted edge by edge rather than through "it looks inserted".
 */
describe('inserting the step in front of the Condition', () => {
    const DEF = () => ({
        trigger: { id: 'trig', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
        steps: [
            { id: 'gmail', type: 'integration_action', position: { x: 200, y: 0 } },
            { id: 'cond', type: 'switch', position: { x: 400, y: 0 } },
            { id: 'notify', type: 'notification', position: { x: 600, y: 0 } },
        ],
        edges: [
            { from: 'trig', to: 'gmail' },
            { from: 'gmail', to: 'cond', color: '#f0f' },
            { from: 'cond', to: 'notify', label: 'case:vip', caseName: 'vip' },
        ],
    });
    const STEP = { id: 'ai_new', type: 'ai_step', label: 'Classify', inputs: {} };

    it('MOVES EVERY INCOMING EDGE onto the new step and hands it straight back', () => {
        const { definition, ok } = insertStepBefore(DEF(), 'cond', STEP);
        expect(ok).toBe(true);
        expect(definition.edges).toContainEqual({ from: 'gmail', to: 'ai_new', color: '#f0f' });
        expect(definition.edges).toContainEqual({ from: 'ai_new', to: 'cond' });
        // The old connection must be GONE, not duplicated: leaving it means
        // the Condition still runs on the unclassified record.
        expect(definition.edges.filter(e => e.from === 'gmail' && e.to === 'cond')).toEqual([]);
    });

    it('LEAVES THE CONDITION REACHABLE — the orphan is the whole risk', () => {
        const { definition } = insertStepBefore(DEF(), 'cond', STEP);
        // Walk it: trigger → … → cond has to exist, or the node never runs
        // and nothing anywhere reports that it stopped.
        const reached = new Set(['trig']);
        let grew = true;
        while (grew) {
            grew = false;
            for (const e of definition.edges) {
                if (reached.has(e.from) && !reached.has(e.to)) { reached.add(e.to); grew = true; }
            }
        }
        expect(reached.has('ai_new')).toBe(true);
        expect(reached.has('cond')).toBe(true);
        expect(reached.has('notify')).toBe(true);
    });

    it('keeps the outgoing branch edges exactly as they were', () => {
        // They leave the Condition, which has not moved — touching them would
        // silently re-route a case.
        const { definition } = insertStepBefore(DEF(), 'cond', STEP);
        expect(definition.edges).toContainEqual({ from: 'cond', to: 'notify', label: 'case:vip', caseName: 'vip' });
    });

    it('binds the record from the one thing above it', () => {
        const { definition } = insertStepBefore(DEF(), 'cond', STEP);
        const added = definition.steps.find(s => s.id === 'ai_new');
        expect(added.inputs).toEqual({ record: { kind: 'ref', path: 'steps.gmail.output' } });
        // Dropped just before the node it feeds, so it does not land on top of it.
        expect(added.position).toEqual({ x: 160, y: 0 });
    });

    it('binds from the trigger when the Condition is the first step', () => {
        const def = DEF();
        def.edges = [{ from: 'trig', to: 'cond' }];
        const { definition } = insertStepBefore(def, 'cond', STEP);
        expect(definition.steps.find(s => s.id === 'ai_new').inputs)
            .toEqual({ record: { kind: 'ref', path: 'trigger.output' } });
    });

    it('does NOT guess when two things feed the node', () => {
        // One of three upstream steps would look configured and read the
        // wrong thing; the step's own editor asks instead.
        const def = DEF();
        def.steps.push({ id: 'drive', type: 'integration_action', position: { x: 200, y: 120 } });
        def.edges.push({ from: 'drive', to: 'cond' });
        const { definition } = insertStepBefore(def, 'cond', STEP);
        expect(definition.steps.find(s => s.id === 'ai_new').inputs).toEqual({});
        // Both feeders still moved across, though.
        expect(definition.edges.filter(e => e.to === 'ai_new').map(e => e.from).sort())
            .toEqual(['drive', 'gmail']);
    });

    it('leaves a plan\'s own binding alone — a per-item step already knows its record', () => {
        const perItemStep = { ...STEP, inputs: { record: { kind: 'ref', path: 'loop.item' } } };
        const { definition } = insertStepBefore(DEF(), 'cond', perItemStep);
        expect(definition.steps.find(s => s.id === 'ai_new').inputs)
            .toEqual({ record: { kind: 'ref', path: 'loop.item' } });
    });

});

describe('what the insert refuses', () => {
    const DEF = () => ({
        trigger: { id: 'trig', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
        steps: [
            { id: 'gmail', type: 'integration_action', position: { x: 200, y: 0 } },
            { id: 'cond', type: 'switch', position: { x: 400, y: 0 } },
        ],
        edges: [{ from: 'trig', to: 'gmail' }, { from: 'gmail', to: 'cond' }],
    });
    const STEP = { id: 'ai_new', type: 'ai_step', label: 'Classify', inputs: {} };

    it('refuses an id that is already taken instead of merging two steps', () => {
        const before = DEF();
        const { definition, ok } = insertStepBefore(before, 'cond', { ...STEP, id: 'gmail' });
        expect(ok).toBe(false);
        expect(definition).toBe(before);
    });

    it('refuses a target it cannot find', () => {
        const before = DEF();
        const { definition, ok } = insertStepBefore(before, 'nope', STEP);
        expect(ok).toBe(false);
        expect(definition).toBe(before);
    });

    it('inserts a Condition that nothing points at yet without stranding it', () => {
        const def = DEF();
        def.edges = def.edges.filter(e => e.to !== 'cond');
        const { definition, ok } = insertStepBefore(def, 'cond', STEP);
        expect(ok).toBe(true);
        expect(definition.edges).toContainEqual({ from: 'ai_new', to: 'cond' });
    });
});
