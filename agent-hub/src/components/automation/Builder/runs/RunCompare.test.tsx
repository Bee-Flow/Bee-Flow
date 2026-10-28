import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { withQueryClient } from '@/test/queryWrapper';
import { authFetch } from '@/utils/helpers';
import RunCompare from './RunCompare';

vi.mock('@/utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

const reply = (status: number, body: unknown) =>
    Promise.resolve({ ok: status < 400, status, headers: new Headers(), json: async () => body } as unknown as Response);

const side = (runId: string, over: Record<string, unknown> = {}) => ({
    runId, status: 'success', mode: 'live', version: 3, triggerKind: 'form', startedAt: '2026-10-01T10:00:00Z', ...over,
});
const step = (stepId: string, over: Record<string, unknown> = {}) => ({
    key: `/${stepId}#`, stepId, stepType: 'action', parentStepId: null,
    a: { present: true, status: 'success' }, b: { present: true, status: 'success' },
    verdict: 'same', softReason: null, kind: 'json', changes: [], changesTruncated: false, ...over,
});

const DEFINITION = { steps: [
    { id: 'read', label: 'Read the list' }, { id: 'ask', label: 'Ask the AI' },
    { id: 'deck', label: 'Make the deck' }, { id: 'table', label: 'Build the table' }, { id: 'only', label: 'Extra step' },
] };

let compareBody: unknown;
let compareStatus = 200;
let compareError: Record<string, unknown> | null = null;

function show() {
    return render(withQueryClient(<RunCompare runId="r1" otherRunId="r2" onClose={vi.fn()} />));
}

beforeEach(() => {
    compareStatus = 200;
    compareError = null;
    compareBody = {
        a: side('r1'), b: side('r2', { mode: 'dry_run', version: 4 }), verdict: 'soft',
        summary: { same: 1, changed: 0, soft: 1, onlyA: 0, onlyB: 0, notComparable: 0 },
        steps: [
            step('read'),
            step('ask', { stepType: 'ai_step', verdict: 'soft', softReason: 'ai', changes: [{ path: 'answer', change: 'changed', before: '"Yes, ship it"', after: '"No, wait"' }] }),
        ],
        truncated: false,
    };
    vi.mocked(authFetch).mockImplementation(((url: string) => {
        if (url.includes('/compare/')) return reply(compareStatus, compareError ?? compareBody);
        if (url.endsWith('/runs/r1/steps')) return reply(200, { steps: [], definition: DEFINITION });
        return reply(404, {});
    }) as typeof authFetch);
});
afterEach(() => cleanup());

describe('RunCompare', () => {
    it('opens with the verdict in plain words and the two runs', async () => {
        show();
        expect(await screen.findByText('Only AI answers differ')).toBeTruthy();
        expect(screen.getByText('0 different · 1 may vary · 1 the same')).toBeTruthy();
        expect(screen.getByText('Run A')).toBeTruthy();
        expect(screen.getByText('Run B')).toBeTruthy();
        expect(screen.getByText(/test run, nothing sent/)).toBeTruthy();
        expect(vi.mocked(authFetch).mock.calls.some(c => c[0] === '/api/automation/runs/r1/compare/r2')).toBe(true);
    });

    it('marks an AI difference as soft and shows the change when the row opens', async () => {
        const user = userEvent.setup();
        show();
        const row = await screen.findByRole('button', { name: /Ask the AI/ });
        expect(within(row).getByText('AI answer: may vary between runs')).toBeTruthy();
        expect(within(row).getByText('Differs, as expected')).toBeTruthy();
        await user.click(row);
        const table = screen.getByRole('table');
        expect(within(table).getByText('answer')).toBeTruthy();
        expect(within(table).getByText('"Yes, ship it"')).toBeTruthy();
        expect(within(table).getByText('"No, wait"')).toBeTruthy();
    });

    it('shows only differences at first, and everything when asked', async () => {
        const user = userEvent.setup();
        show();
        await screen.findByRole('button', { name: /Ask the AI/ });
        expect(screen.queryByRole('button', { name: /Read the list/ })).toBeNull();
        const box = screen.getByRole('checkbox', { name: 'Show only differences' });
        expect((box as HTMLInputElement).checked).toBe(true);
        await user.click(box);
        expect(screen.getByRole('button', { name: /Read the list/ })).toBeTruthy();
    });

    it('says so when nothing differs', async () => {
        compareBody = { ...(compareBody as object), verdict: 'same', summary: { same: 2, changed: 0, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 }, steps: [step('read')] };
        show();
        expect(await screen.findByText('Same result')).toBeTruthy();
        expect(screen.getByText('No differences. Every step gave the same result.')).toBeTruthy();
    });
});

describe('RunCompare: files, unknown kinds and refusals', () => {
    it('summarises a changed file per slide', async () => {
        const user = userEvent.setup();
        const slide = (index: number, over: Record<string, unknown> = {}) => ({ kind: 'slide', index, title: `Slide ${index + 1}`, textChars: 100, textHash: 'aa', ...over });
        compareBody = {
            ...(compareBody as object), verdict: 'changed',
            steps: [step('deck', {
                stepType: 'generate_document', verdict: 'changed', kind: 'generated_file',
                changes: [{ path: 'slides[1].title', change: 'changed', before: '"Slide 2"', after: '"New title"' }],
                files: [{
                    stepId: 'deck', change: 'changed',
                    a: { name: 'plan.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 2048, sha256: 'x', parts: [slide(0), slide(1)] },
                    b: { name: 'plan.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 2100, sha256: 'y', parts: [slide(0), slide(1, { title: 'New title', textChars: 80 })] },
                }],
            })],
        };
        show();
        await user.click(await screen.findByRole('button', { name: /Make the deck/ }));
        expect(screen.getByText('plan.pptx')).toBeTruthy();
        expect(screen.getByText('Content changed')).toBeTruthy();
        expect(screen.getByText('Slide 2 (New title)')).toBeTruthy();
        expect(screen.getByText(/Text length/)).toBeTruthy();
        // Slide 1 did not change, so it is not listed.
        expect(screen.queryByText(/^Slide 1/)).toBeNull();
    });

    it('lists the changes of a kind it does not know in the same table', async () => {
        const user = userEvent.setup();
        compareBody = {
            ...(compareBody as object), verdict: 'changed',
            steps: [step('table', { verdict: 'changed', kind: 'table', changesTruncated: true, changes: [
                { path: 'columns[2]', change: 'added', after: '"score"' },
                { path: 'rows.length', change: 'changed', before: '10', after: '12' },
            ] })],
        };
        show();
        await user.click(await screen.findByRole('button', { name: /Build the table/ }));
        const table = screen.getByRole('table');
        expect(within(table).getByText('columns[2]')).toBeTruthy();
        expect(within(table).getByText('"score"')).toBeTruthy();
        expect(within(table).getByText('rows.length')).toBeTruthy();
        expect(screen.getByText('More changes not shown.')).toBeTruthy();
    });

    it('words a step that ran on one side only', async () => {
        compareBody = { ...(compareBody as object), verdict: 'changed', steps: [step('only', { verdict: 'only_a', b: { present: false, status: null } })] };
        show();
        expect(await screen.findByText('Only in run A')).toBeTruthy();
    });

    it.each([
        ['runs_not_comparable', 400, 'These two runs belong to different automations, so they cannot be compared.'],
        ['caller_run_private', 403, 'This run used the connections of the person who started it, so only they can see its data.'],
        ['run_not_found', 404, 'That run could not be found, or you cannot read its data.'],
    ])('explains %s in plain language', async (code, status, text) => {
        compareStatus = status;
        compareError = { error: 'x', code };
        show();
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(text));
    });
});
