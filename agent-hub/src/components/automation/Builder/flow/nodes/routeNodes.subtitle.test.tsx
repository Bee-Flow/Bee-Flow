import { cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import type { ComponentType } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import ConditionNodeJs from './ConditionNode';
import FilterNodeJs from './FilterNode';
import SwitchNodeJs from './SwitchNode';
import { NodeRuntimeContext } from '../NodeRuntimeContext';

type AnyNode = ComponentType<Record<string, unknown>>;
const FilterNode = FilterNodeJs as unknown as AnyNode;
const SwitchNode = SwitchNodeJs as unknown as AnyNode;
const ConditionNode = ConditionNodeJs as unknown as AnyNode;

/**
 * The Condition's cards read in plain words (C1, C2): the list by its name,
 * the rule as the sentence its rows read. Never `‹Step›`, `item.`, a function
 * call or a raw path, on the card or in its tooltip.
 */
const LABELS = new Map([['mc_read_many', 'Read many'], ['ai_1', 'Classify'], ['mc_keep', 'Keep invoices'], ['ms_split', 'Split by type']]);
const RUNTIME = {
    pinnedById: new Set(), disabledById: new Set(), triggerIds: new Set(), attachedIds: new Set(),
    typeGroupById: new Map(), stepTypeById: new Map([['mc_keep', 'filter'], ['ms_split', 'switch']]), stepNumberById: new Map(),
};

function renderNode(Node: AnyNode, step: Record<string, unknown>) {
    render(
        <ReactFlowProvider>
            <NodeRuntimeContext.Provider value={RUNTIME as never}>
                <Node id={String(step.id)} data={{ step, stepLabelById: LABELS, issues: [] }} />
            </NodeRuntimeContext.Provider>
        </ReactFlowProvider>,
    );
    return cardSummary();
}

/**
 * The card's summary as one reading: a list card prints the list on the first
 * line and the rule on a second (`node-sub-detail`), so the rule is never
 * truncated away; read together they are "<list> · <rule>".
 */
type Summary = { textContent: string; className: string; getAttribute: (name: string) => string | null; lines: HTMLElement[] };
function cardSummary(): Summary {
    const sub = screen.getByTestId('node-sub');
    const detail = screen.queryByTestId('node-sub-detail');
    const lines = detail ? [sub, detail] : [sub];
    return {
        textContent: lines.map((l) => l.textContent || '').join(' · '),
        className: sub.className,
        getAttribute: (name) => sub.getAttribute(name),
        lines,
    };
}

function expectPlainWords(el: Summary) {
    for (const text of [el.textContent || '', el.getAttribute('title') || '']) {
        expect(text).not.toContain('‹');
        expect(text).not.toContain('item.');
        expect(text).not.toContain('steps.');
        expect(text).not.toContain('(');
    }
}

describe('Filter card (C1)', () => {
    afterEach(cleanup);

    it('reads "<list> · <rule sentence>", tooltip the same text', () => {
        const sub = renderNode(FilterNode, {
            id: 'mc_condition', type: 'filter', arrayRef: 'steps.mc_read_many.output.messages',
            expr: 'anyOf(fileType(item.attachments[*]), "equals", "pdf")',
        });
        expect(sub.textContent).toBe('Read many ▸ Messages · any attachment · File type is PDF');
        expect(sub.getAttribute('title')).toBe('Read many ▸ Messages · any attachment · File type is PDF');
        // List on line 1, the rule on line 2, each with the whole sentence as its tooltip.
        expect(sub.lines.map((l) => l.textContent)).toEqual(['Read many ▸ Messages', 'any attachment · File type is PDF']);
        expect(sub.lines[1].getAttribute('title')).toBe('Read many ▸ Messages · any attachment · File type is PDF');
        expectPlainWords(sub);
    });

    it('reads the user\'s saved column rule as a sentence', () => {
        const sub = renderNode(FilterNode, {
            id: 'mc_condition', type: 'filter', arrayRef: 'steps.mc_read_many.output.messages',
            expr: 'contains(item.attachments[*].mimeType, "pdf")',
        });
        expect(sub.textContent).toBe('Read many ▸ Messages · any attachment · Mime type contains “pdf”');
        expectPlainWords(sub);
    });

    it('a list inside each row reads as the step and the inner list', () => {
        const sub = renderNode(FilterNode, {
            id: 'f', type: 'filter', arrayRef: 'steps.mc_read_many.output.messages[*].attachments',
            expr: 'equals(fileType(item), "pdf")',
        });
        expect(sub.textContent).toBe('Read many ▸ Attachments · File type is PDF');
        expectPlainWords(sub);
    });

    it('says what is missing yet, muted', () => {
        const noRule = renderNode(FilterNode, { id: 'f', type: 'filter', arrayRef: 'steps.mc_read_many.output.messages', expr: 'true' });
        expect(noRule.textContent).toBe('Read many ▸ Messages · no rule yet');
        expect(screen.getByText('no rule yet').className).toContain('italic');
        expect(screen.queryByTestId('node-sub-detail')?.className).toContain('italic');
        expect(screen.getByTestId('node-sub').className).not.toContain('italic');
        cleanup();
        const nothing = renderNode(FilterNode, { id: 'f', type: 'filter', arrayRef: '', expr: '' });
        expect(nothing.textContent).toBe('no list yet · no rule yet');
        expect(nothing.className).toContain('italic');
    });

    it('a formula reads "Custom rule", not its code', () => {
        const sub = renderNode(FilterNode, {
            id: 'f', type: 'filter', arrayRef: 'steps.mc_read_many.output.messages', expr: 'len(item.attachments) > 2',
        });
        expect(sub.textContent).toBe('Read many ▸ Messages · Custom rule');
        expectPlainWords(sub);
    });
});

describe('Switch card (C2)', () => {
    afterEach(cleanup);

    const cases = [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }, { name: 'word', expr: 'equals(fileType(item), "word")' }, { name: 'powerpoint', expr: 'equals(fileType(item), "powerpoint")' }];

    it('list mode: "<list> · 3 outputs + Otherwise", ports named by case and Otherwise', () => {
        const sub = renderNode(SwitchNode, {
            id: 'ms_split', type: 'switch', arrayRef: 'steps.mc_read_many.output.messages[*].attachments', cases, routeStyle: 'rules',
        });
        expect(sub.textContent).toBe('Read many ▸ Attachments · 3 outputs + Otherwise');
        expect(sub.getAttribute('title')).toBe('Read many ▸ Attachments · 3 outputs + Otherwise');
        expect(sub.lines.map((l) => l.textContent)).toEqual(['Read many ▸ Attachments', '3 outputs + Otherwise']);
        expectPlainWords(sub);
        for (const port of ['pdf', 'word', 'powerpoint', 'Otherwise']) expect(screen.getByText(port)).toBeTruthy();
    });

    it('whole run: "3 outputs + Otherwise"; a redirected catch-all drops "+ Otherwise"', () => {
        const whole = renderNode(SwitchNode, { id: 's', type: 'switch', cases });
        expect(whole.textContent).toBe('3 outputs + Otherwise');
        expect(whole.lines).toHaveLength(1);
        cleanup();
        expect(renderNode(SwitchNode, { id: 's', type: 'switch', cases, defaultBranch: 'pdf' }).textContent).toBe('3 outputs');
    });

    it('one output with the rest to Otherwise reads like a filter card: "<list> · <rule> + Otherwise"', () => {
        const sub = renderNode(SwitchNode, {
            id: 'k', type: 'switch', arrayRef: 'steps.mc_read_many.output.messages', routeStyle: 'rules',
            cases: [{ name: 'Output 1', expr: 'contains(item.subject, "x")' }],
        });
        expect(sub.textContent).toBe('Read many ▸ Messages · Subject contains “x” + Otherwise');
        expect(sub.textContent).not.toContain('outputs');
        expectPlainWords(sub);
        expect(screen.getByText('Otherwise')).toBeTruthy();
    });

    it('one output is singular: "1 output + Otherwise", "1 output"', () => {
        const one = [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }];
        expect(renderNode(SwitchNode, { id: 's', type: 'switch', cases: one }).textContent).toBe('1 output + Otherwise');
        cleanup();
        expect(renderNode(SwitchNode, { id: 's', type: 'switch', cases: one, defaultBranch: 'pdf' }).textContent).toBe('1 output');
    });

    it('a list read from an earlier Condition reads as its output, not its runner keys', () => {
        const sub = renderNode(SwitchNode, { id: 's', type: 'switch', arrayRef: 'steps.ms_split.output.matchesByCase.pdf', cases });
        expect(sub.textContent).toBe('Split by type ▸ pdf · 3 outputs + Otherwise');
        cleanup();
        const kept = renderNode(FilterNode, { id: 'f', type: 'filter', arrayRef: 'steps.mc_keep.output.items[*].attachments', expr: 'equals(fileType(item), "pdf")' });
        expect(kept.textContent).toBe('Keep invoices ▸ Attachments · File type is PDF');
        cleanup();
        const all = renderNode(FilterNode, { id: 'f', type: 'filter', arrayRef: 'steps.mc_keep.output.items', expr: 'equals(fileType(item), "pdf")' });
        expect(all.textContent).toBe('Keep invoices · File type is PDF');
    });

    it('a list switch with no list yet says so, muted', () => {
        const sub = renderNode(SwitchNode, { id: 's', type: 'switch', arrayRef: '', cases });
        expect(sub.textContent).toBe('no list yet · 3 outputs + Otherwise');
        expect(sub.className).toContain('italic');
    });
});

describe('Condition card (C2)', () => {
    afterEach(cleanup);

    it('whole run: the rule sentence, ports "Match" and "Otherwise"', () => {
        const sub = renderNode(ConditionNode, { id: 'c', type: 'condition', expr: 'steps.ai_1.output.urgent == true' });
        expect(sub.textContent).toBe('Classify ▸ Urgent is true');
        expectPlainWords(sub);
        expect(screen.getByText('Match')).toBeTruthy();
        expect(screen.getByText('Otherwise')).toBeTruthy();
    });

    it('no rule yet, muted', () => {
        const sub = renderNode(ConditionNode, { id: 'c', type: 'condition', expr: '' });
        expect(sub.textContent).toBe('no rule yet');
        expect(sub.className).toContain('italic');
    });
});
