/**
 * The approval editor held to the web's (approvalEditors.jsx, a component
 * file): the deadline and clock choices are its lists; `approvalQuestionName`
 * is cut out and run beside the port (with the form builder's own
 * slugifyFieldName); and the two mode switches — the component's `useStages`
 * and `dropStages` closures — are cut out and run against a recording `set`,
 * so "turn stages on / off" carries over exactly what the web carries over.
 * Then what an edit saves, through formState.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { FlowNode } from '@/features/flow-editor/bindings';
import { buildPatch, extractFormState, type FormDraft } from '@/features/flow-editor/formState';

import { addQuestion, addStage, approvalQuestionName, CLOCK_CHOICES, chooseEscalation, DEADLINE_CHOICES, deadlineChoices, joinChoices, oneRoundFrom, splitChoices, stagesFrom, startPanel } from './approvalModel';

const SETTINGS = path.resolve(__dirname, '../../../../../../../agent-hub/src/components/automation/Builder/flow/settings');
const src = fs.readFileSync(path.join(SETTINGS, 'approvalEditors.jsx'), 'utf8');
const formSrc = fs.readFileSync(path.join(SETTINGS, 'FormBuilderFields.jsx'), 'utf8');
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const webState = require(path.join(SETTINGS, 'formState.js'));

const between = (text: string, start: string, end: string) => {
    const at = text.indexOf(start);
    if (at < 0) throw new Error(`${start} is gone`);
    return text.slice(at, text.indexOf(end, at) + end.length);
};
const fn = (text: string, name: string) => between(text, `function ${name}(`, '\n}\n').replace(/^export /, '');

const naming = new Function(
    `${fn(formSrc, 'slugifyFieldName')}\n${between(src, 'const PLACEHOLDER_QUESTION_NAME', ';\n')}\n${fn(src, 'storedQuestionName')}\n${fn(src, 'approvalQuestionName')}\nreturn { approvalQuestionName };`,
)();

/** The component's closure, run with the draft it would see and a `set` that records. */
function webSwitch(name: 'useStages' | 'dropStages', draft: FormDraft): FormDraft {
    const body = between(src, `const ${name} = () => {`, '\n    };\n');
    const out: FormDraft = {};
    const set = (k: string, v: unknown) => {
        out[k] = v;
    };
    const panelSeats = Array.isArray(draft.approvers) ? draft.approvers : [];
    const stages = Array.isArray(draft.stages) ? draft.stages : [];
    const t = (_k: string, fb: string) => fb;
    new Function('draft', 'set', 'panelSeats', 'stages', 't', 'STAGE_RULES', 'newStageKey', 'stageSeats', `${body}\n${name}();`)(
        draft,
        set,
        panelSeats,
        stages,
        t,
        webState.STAGE_RULES,
        webState.newStageKey,
        webState.stageSeats,
    );
    return out;
}

const pairs = (block: string) => [...block.matchAll(/\{ value: (\d+), label: '([^']+)' \}/g)].map((m) => [Number(m[1]), m[2]]);

describe('the approval editor against approvalEditors.jsx', () => {
    it('offers the web’s deadline and reminder choices', () => {
        expect(DEADLINE_CHOICES.map((c) => [c.value, c.label[1]])).toEqual(pairs(between(src, 'const APPROVAL_DEADLINE_CHOICES = [', '];')));
        expect(CLOCK_CHOICES.map((c) => [c.value, c.label[1]])).toEqual(pairs(between(src, 'const APPROVAL_CLOCK_CHOICES = [', '];')));
        expect(deadlineChoices(10).choices.at(-1)?.label).toEqual(['mobile.flow.approval.n_hours', '{n} hours', { n: 10 }]);
        expect(deadlineChoices('').hours).toBe(168);
        expect(deadlineChoices(0).hours).toBe(0);
    });

    const qs = (...labels: [string, string][]) => labels.map(([name, label]) => ({ name, label }));
    it.each([
        [qs(['q1', 'Invoice number']), 0],
        [qs(['invoice_number', 'Invoice number (from the PO)']), 0],
        [qs(['q1', '2nd signature']), 0],
        [qs(['amount', 'Amount'], ['q2', 'Amount']), 1],
        [qs(['q1', '']), 0],
        [qs(['', '']), 2],
    ])('names a question as the web does (%j, %i)', (questions, i) => {
        expect(approvalQuestionName(questions[i], i, questions)).toBe(naming.approvalQuestionName(questions[i], i, questions));
    });

    it('mints placeholder names past the ones in use', () => {
        expect(addQuestion([{ name: 'q2' }]).at(-1)).toEqual({ name: 'q3', label: '', type: 'text', required: false });
        expect(addQuestion([{ name: 'q1' }, { name: 'q3' }]).at(-1)?.name).toBe('q4');
    });

    it('keeps a choice line as typed and hands back the pairs', () => {
        expect(joinChoices([{ value: 'a', label: 'A' }, { value: 'b' }, 'c', null])).toBe('A, b, c');
        expect(splitChoices(' a, ,b ,')).toEqual(['a', 'b']);
    });

    const seatA = { userId: 'u1' };
    const seatB = { groupId: 'g1' };
    it.each<[string, FormDraft]>([
        ['a single approver', { assignee: seatA }],
        ['nobody', {}],
        ['a panel with a quorum', { approvers: [seatA, null, seatB], rule: 'quorum', quorum: 2 }],
        ['a one-seat panel and a final sign-off', { approvers: [seatA], rule: 'first', finalApprover: seatB }],
    ])('turns stages on from %s as the web does', (_name, draft) => {
        expect(stagesFrom(draft, 'Final sign-off')).toEqual(webSwitch('useStages', draft));
    });

    it.each<[string, FormDraft]>([
        ['one stage, one seat', { stages: [{ key: 's1', approvers: [seatA], rule: 'all' }] }],
        ['a panel stage and a one-seat last stage', { stages: [{ key: 's1', approvers: [seatA, seatB], rule: 'quorum', quorum: 5 }, { key: 's2', approvers: [seatB], rule: 'first' }] }],
        ['an empty chain', { stages: [] }],
    ])('turns stages off from %s as the web does', (_name, draft) => {
        expect(oneRoundFrom(draft)).toEqual(webSwitch('dropStages', draft));
    });

    it('adds a stage under the lowest free key, and never re-derives one from a position', () => {
        expect(addStage([{ key: 's2' }]).at(-1)).toEqual({ key: 's1', name: '', description: '', approvers: [null], rule: 'all' });
    });

    it('starts a panel with the current approver, and gives an escalation a delay', () => {
        expect(startPanel({ assignee: seatA })).toEqual({ approvers: [seatA, null], assignee: null });
        expect(chooseEscalation({}, 'g:g1')).toEqual({ escalateTo: { groupId: 'g1' }, escalateAfterHours: 24 });
        expect(chooseEscalation({ escalateAfterHours: 4 }, 'u:x')).toEqual({ escalateTo: { userId: 'x' } });
        expect(chooseEscalation({ escalateAfterHours: 4 }, '')).toEqual({ escalateTo: null, escalateAfterHours: '' });
    });
});

describe('what an approval edit saves', () => {
    const step = { id: 'a1', type: 'approval', prompt: 'OK?', approval: { assignee: { userId: 'u1' }, expiresInHours: 24 } } as unknown as FlowNode;

    it('a chain supersedes the one-round approver', () => {
        const draft = extractFormState(step);
        const patch = buildPatch(step, { ...draft, ...stagesFrom(draft, 'Final sign-off') });
        expect(patch.approval).toEqual({ expiresInHours: 24, stages: [{ key: 's1', approvers: [{ userId: 'u1' }], rule: 'all' }] });
    });

    it('drops a question with neither name nor label, and a document with no file', () => {
        const draft = extractFormState(step);
        const patch = buildPatch(step, { ...draft, approvalFields: [{ name: '', label: '' }, { name: 'q1', label: 'Why' }], attachments: [{ binding: '' }, { binding: '{{x}}', label: '' }] });
        expect(patch.approval).toMatchObject({ fields: [{ name: 'q1', label: 'Why' }], attachments: [{ binding: '{{x}}' }] });
    });
});
