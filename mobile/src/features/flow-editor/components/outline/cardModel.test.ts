import type { AnyNode, FlowDefinition, Translate } from '@/features/flow-editor/model';
import { clone, loopy } from '@/features/flow-editor/model/testing/fixtures';

import { cardModel } from './cardModel';
import { cardLabelMap } from './stepLabels';
import { stepName, stepSummary } from './stepSummary';

const t: Translate = (_key, fallback, params) => fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));
const ctx = { t };
const F = { name: 'q', type: 'text' };
const node = (n: Partial<AnyNode> & { type: string }) => ({ id: 'x', ...n }) as AnyNode;

describe('a card’s words', () => {
    it('reads each type the way its web card does', () => {
        expect(stepSummary(node({ type: 'ai_step', prompt: '  Sort the mail\n\nby sender ' }), ctx)).toBe('Sort the mail by sender');
        expect(stepSummary(node({ type: 'ai_step' }), ctx)).toEqual({ muted: 'no prompt yet' });
        expect(stepSummary(node({ type: 'http_request', url: 'https://x.test' }), ctx)).toBe('GET https://x.test');
        expect(stepSummary(node({ type: 'http_request', method: 'post' }), ctx)).toEqual({ muted: 'POST · no URL set' });
        expect(stepSummary(node({ type: 'code', code: 'a\nb', codeHash: '0123456789' }), ctx)).toBe('2 lines · 01234567');
        expect(stepSummary(node({ type: 'loop', overRef: 'steps.s1.output.rows', itemVar: 'row', batchSize: 5 }), ctx)).toMatch(/· as loop\.row · ×5$/);
        expect(stepSummary(node({ type: 'loop' }), ctx)).toEqual({ muted: 'no list yet · as loop.item' });
        expect(stepSummary(node({ type: 'parallel', branches: [[{ id: 'a', type: 'set', label: 'Make folder' }], [], [{ id: 'n', type: 'note' }]] }), ctx))
            .toBe('Make folder · empty · empty — all at the same time');
        expect(stepSummary(node({ type: 'form_page', form: { title: 'More', fields: [F, F] } }), ctx)).toBe('More · 2 questions');
        expect(stepSummary(node({ type: 'wait', seconds: 7200 }), ctx)).toBe('2 hours');
    });

    it('says what starts the automation', () => {
        expect(stepSummary(node({ type: 'trigger', kind: 'manual' }), ctx)).toBe('Runs on the Run button');
        expect(stepSummary(node({ type: 'trigger', kind: 'schedule' }), ctx)).toEqual({ muted: 'no schedule yet' });
        expect(stepSummary(node({ type: 'trigger', kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }), ctx)).toBe('New email (Gmail)');
        expect(stepSummary(node({ type: 'trigger', kind: 'form', form: { title: 'Intake', fields: [F] } }), ctx)).toBe('Intake · 1 question');
        expect(stepName(node({ type: 'trigger', kind: 'webhook' }), ctx)).toBe('Webhook');
    });

    it('names an unnamed step as the web card does', () => {
        expect(stepName(node({ type: 'integration_action', tool: 'gmail_send_email' }), ctx)).toBe('Gmail Send Email');
        expect(stepName(node({ type: 'condition' }), ctx)).toBe('Condition');
        expect(stepName(node({ type: 'form_page', mode: 'ending' }), ctx)).toBe('Closing page');
        expect(stepName(node({ type: 'set', label: ' Tidy ' }), ctx)).toBe('Tidy');
    });
});

describe('cardModel', () => {
    it('puts the family, the number, the run result, the pin and the findings on one card', () => {
        const def: FlowDefinition = clone(loopy);
        def.steps[1] = { ...def.steps[1], pinnedOutput: { a: 1 } } as FlowDefinition['steps'][number];
        const card = cardModel(def, 'lim', {
            t,
            numbers: new Map([['lim', 3]]),
            runByStep: new Map([['lim', { status: 'success', output: [1, 2] }]]),
            issuesByStep: new Map([['lim', { errors: [{ message: 'x' }], warnings: [] }]]),
        });
        expect(card).toMatchObject({ family: 'data', icon: 'ChevronsDown', status: 'success', result: '2 items', pinned: true, errors: 1, warnings: 0 });
        expect(card?.kicker).toMatch(/ · 3$/);
    });

    it('finds a held step by its address, and nothing at an address that is gone', () => {
        expect(cardModel(loopy, 'loop_1/b_set', { t })?.name).toBe('B_SET');
        expect(cardModel(loopy, 'loop_1/nope', { t })).toBeNull();
    });
});

describe('the data a card names', () => {
    // An unlabelled Gmail search, as the AI builder leaves one.
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: [
            { id: 'act_4d4307a', type: 'integration_action', tool: 'gmail_search' },
            { id: 'ai_1', type: 'ai_step', label: 'Summarise', prompt: 'Summarise {{steps.act_4d4307a.output.body}}' },
            {
                id: 'loop_1',
                type: 'loop',
                label: 'Per mail',
                overRef: 'steps.act_4d4307a.output.results[*]',
                itemVar: 'mail',
                body: [
                    { id: 'b_ai', type: 'ai_step', label: 'Draft a reply', prompt: 'Reply to {{loop.mail.subject}}' },
                    { id: 'b_note', type: 'notification', title: 'Draft for {{loop.mail.from}}', body: '{{steps.b_ai.output.text}}' },
                ],
            },
            { id: 'lim', type: 'limit', arrayRef: 'steps.act_4d4307a.output.results', count: 3 },
            { id: 'cond', type: 'condition', expr: 'steps.ai_1.output.score * 2 > trigger.output.cap' },
            { id: 'ok', type: 'approval', prompt: `Send ${'the reply '.repeat(5)}to {{steps.act_4d4307a.output.from}}?` },
        ],
        edges: [],
    } as unknown as FlowDefinition;
    const labels = cardLabelMap(def, t);
    const card = (address: string) => cardModel(def, address, { t, stepLabelById: labels });

    it('names a step without a label as its card does, the steps inside a loop included', () => {
        expect(labels.get('act_4d4307a')).toBe('Gmail Search');
        expect(labels.get('b_ai')).toBe('Draft a reply');
        expect(labels.get('trg')).toBe('Manual');
    });

    it('shows a reference in a prompt or a message by name, never as {{…}}', () => {
        expect(card('ai_1')?.sub).toBe('Summarise ‹Gmail Search ▸ Body›');
        expect(card('loop_1/b_ai')?.sub).toBe('Reply to ‹Loop item · mail ▸ Subject›');
        expect(card('loop_1/b_note')).toMatchObject({ name: 'Draft for ‹Loop item · mail ▸ From›', sub: '‹Draft a reply ▸ Text›' });
    });

    it('names the list a loop or a list step works through', () => {
        expect(card('loop_1')).toMatchObject({ sub: 'over: ‹Gmail Search ▸ Results› · as loop.mail', list: '‹Gmail Search ▸ Results›' });
        expect(card('lim')?.sub).toBe('First 3 of ‹Gmail Search ▸ Results›');
        expect(card('ai_1')?.list).toBeNull();
    });

    it('names the references in a rule it cannot put in words', () => {
        expect(card('cond')?.sub).toBe('‹Summarise ▸ Score› * 2 > ‹Trigger ▸ Cap›');
    });

    it('names a long question before cutting it, so the cut never leaves half a {{…', () => {
        expect(card('ok')?.sub).toBe(`Send ${'the reply '.repeat(5)}to ‹Gmail Search ▸ From›?`.slice(0, 59) + '…');
    });

    it('finds the names in the definition when the context brings none', () => {
        expect(cardModel(def, 'loop_1/b_note', { t })?.sub).toBe('‹Draft a reply ▸ Text›');
    });
});
