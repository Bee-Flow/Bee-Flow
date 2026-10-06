/**
 * A Condition's card on the phone tells the same story as its web card
 * (SwitchNode switchSubtitle, FilterNode filterSubtitle, spec C1/C2): "3
 * outputs + Otherwise", never "3 rules"; "+ Otherwise" off when the catch-all
 * is redirected; "no list yet" / "no rule yet" for what is not there yet. And
 * a step that reads a Condition's output names it without the runner's keys
 * ("Matches by case", "Items", "Default").
 */

import type { FlowDefinition, Translate } from '@/features/flow-editor/model';

import { cardModel } from './cardModel';

const t: Translate = (_key, fallback, params) => fallback.replace(/\{(\w+)\}/g, (_, k: string) => String(params?.[k] ?? ''));

const MAILS = 'steps.mc_read_many.output.messages';
const ATTACHMENTS = `${MAILS}[*].attachments`;
const isPdf = 'equals(fileType(item), "pdf")';

const def = {
    trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
    steps: [
        { id: 'mc_read_many', type: 'integration_action', label: 'Read many', tool: 'gmail_search' },
        {
            id: 'split', type: 'switch', label: 'Split', arrayRef: ATTACHMENTS, matchMode: 'all',
            cases: [{ name: 'pdf', expr: isPdf }, { name: 'word', expr: 'equals(fileType(item), "word")' }, { name: 'excel', expr: 'equals(fileType(item), "excel")' }],
        },
        { id: 'redirected', type: 'switch', label: 'Redirected', arrayRef: ATTACHMENTS, defaultBranch: 'pdf', cases: [{ name: 'pdf', expr: isPdf }, { name: 'word', expr: 'true' }] },
        { id: 'keep_rest', type: 'switch', label: 'Keep rest', arrayRef: MAILS, cases: [{ name: 'Output 1', expr: 'contains(item.subject, "x")' }] },
        { id: 'whole', type: 'switch', label: 'Whole run', expr: '', cases: [{ name: 'a', expr: 'true' }, { name: 'b', expr: 'true' }, { name: '', expr: 'true' }] },
        { id: 'no_list', type: 'switch', label: 'No list', arrayRef: '', cases: [{ name: 'a', expr: 'true' }, { name: 'b', expr: 'true' }] },
        { id: 'keep', type: 'filter', label: 'Keep', arrayRef: MAILS, expr: 'contains(item.from, "fabrikam") || contains(item.subject, "isv")' },
        { id: 'f_no_rule', type: 'filter', label: 'No rule', arrayRef: MAILS, expr: 'true' },
        { id: 'f_none', type: 'filter', label: 'Nothing' },
        { id: 'loop_pdf', type: 'loop', label: 'Per pdf', overRef: 'steps.split.output.matchesByCase.pdf', itemVar: 'file' },
        { id: 'loop_rest', type: 'loop', label: 'Per rest', overRef: 'steps.split.output.matchesByCase.default', itemVar: 'file' },
        { id: 'loop_kept', type: 'loop', label: 'Per kept', overRef: 'steps.keep.output.items[*].attachments', itemVar: 'file' },
    ],
    edges: [],
} as unknown as FlowDefinition;

const card = (id: string, tr: Translate = t) => cardModel(def, id, { t: tr });

describe('a Condition card with several outputs (C2)', () => {
    it('counts outputs and adds “+ Otherwise”, naming the list the way the canvas does', () => {
        expect(card('split')).toMatchObject({ sub: '‹Read many ▸ Attachments› · 3 outputs + Otherwise', subMuted: false });
    });

    it('leaves “+ Otherwise” off when the catch-all is redirected into an output', () => {
        expect(card('redirected')?.sub).toBe('‹Read many ▸ Attachments› · 2 outputs');
    });

    it('reads one output with keep-rest like a filter card, then “+ Otherwise”', () => {
        expect(card('keep_rest')?.sub).toBe('‹Read many ▸ Messages› · Subject contains “x” + Otherwise');
    });

    it('counts only named outputs for a whole-run Condition, without a list', () => {
        expect(card('whole')?.sub).toBe('2 outputs + Otherwise');
    });

    it('mutes a list Condition that has no list yet', () => {
        expect(card('no_list')).toMatchObject({ sub: 'no list yet · 2 outputs + Otherwise', subMuted: true });
    });
});

describe('a filter card (C1)', () => {
    it('says the list, then the rule', () => {
        expect(card('keep')).toMatchObject({ sub: '‹Read many ▸ Messages› · From contains “fabrikam” or Subject contains “isv”', subMuted: false });
    });

    it('says “no rule yet” / “no list yet”, muted, for what is not there', () => {
        expect(card('f_no_rule')).toMatchObject({ sub: '‹Read many ▸ Messages› · no rule yet', subMuted: true });
        expect(card('f_none')).toMatchObject({ sub: 'no list yet · no rule yet', subMuted: true });
    });

    it('joins the rows of a rule in the reader’s language', () => {
        const nl: Translate = (key, fallback, params) => ({ 'condition_node.join.or': 'of', 'condition_node.join.and': 'en' })[key] ?? t(key, fallback, params);
        expect(card('keep', nl)?.sub).toBe('‹Read many ▸ Messages› · From contains “fabrikam” of Subject contains “isv”');
    });
});

describe('a step that reads a Condition’s output', () => {
    it('names an output by its own name and the catch-all “Otherwise”, never “Matches by case”', () => {
        expect(card('loop_pdf')?.list).toBe('‹Split ▸ pdf›');
        expect(card('loop_rest')?.list).toBe('‹Split ▸ Otherwise›');
    });

    it('names what a list Condition keeps as the Condition itself, never “Items”', () => {
        expect(card('loop_kept')?.list).toBe('‹Keep ▸ Attachments (inside each row)›');
    });
});
