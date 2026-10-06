import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalPath, getPath } from '@shared/expr/path.mjs';
import OutputView from '../OutputView';
import { NESTED_TEXT_OUTPUT } from '../mapping/upstream/fixtures/discovery';

/**
 * JSON nested at several levels, with JSON TEXT inside JSON text (an HTTP
 * body holding a payload holding list items whose meta is text again, down to
 * a fenced AI answer), is shown as the records and tables it encodes — never
 * as an escaped string — and every value picked from it writes a path the
 * runtime resolves to that value.
 */
const BASE = 'steps.http.output';
const HTTP_OUT = { status: 200, ok: true, headers: { 'content-type': 'text/plain' }, truncated: false, ...NESTED_TEXT_OUTPUT };
const ROOT = { steps: { http: { output: HTTP_OUT } } };

afterEach(cleanup);

const header = (label: string) => screen.getAllByRole('columnheader').find(h => within(h).queryByText(label)) as HTMLElement;

describe('JSON text in the Table view', () => {
    it('renders as the structure it encodes, and drills down to the fenced answer', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<OutputView value={HTTP_OUT} basePath={BASE} enableDrag onPickPath={onPick} />);
        // No raw JSON text on screen, at any level.
        expect(screen.queryByText(/\{"/)).toBeNull();
        expect(screen.getByText('Payload')).toBeTruthy();
        // The list of items is a table; its `meta` (text again) opens into columns.
        await user.click(header('Sku'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.body.data.payload.items[*].sku`, { raw: false });
        await user.click(within(header('Meta')).getByRole('button', { name: 'Show fields' }));
        await user.click(within(header('Ai')).getByRole('button', { name: 'Show fields' }));
        await user.click(within(header('Verdict')).getByRole('button', { name: 'Show fields' }));
        // The header names every level it was opened through.
        expect(within(header('Reason code')).getByRole('button', { name: 'Ai ›' })).toBeTruthy();
        expect(within(header('Reason code')).getByRole('button', { name: 'Meta ›' })).toBeTruthy();
        expect(within(header('Reason code')).getByRole('button', { name: 'Verdict ›' })).toBeTruthy();
        await user.click(header('Reason code'));
        const path = onPick.mock.calls.at(-1)?.[0] as string;
        expect(path).toBe(`${BASE}.body.data.payload.items[*].meta.ai.verdict["reason code"]`);
        expect(getPath(ROOT, path)).toEqual(['R-7']);
        // A single cell, one row down.
        const cell = screen.getByText('R-7');
        await user.click(cell);
        const cellPath = onPick.mock.calls.at(-1)?.[0] as string;
        expect(cellPath).toBe(`${BASE}.body.data.payload.items[0].meta.ai.verdict["reason code"]`);
        expect(getPath(ROOT, cellPath)).toBe('R-7');
        for (const [p] of onPick.mock.calls) expect(canonicalPath(p)).toBe(p);
    });

    it('a whole output that is JSON text opens as a record', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        const answer = '```json\n{"sentiment":"positive","topics":["billing","refund"]}\n```';
        render(<OutputView value={answer} basePath="steps.ai.output" enableDrag onPickPath={onPick} />);
        expect(screen.queryByText(/```/)).toBeNull();
        await user.click(screen.getByText('positive'));
        expect(onPick).toHaveBeenLastCalledWith('steps.ai.output.sentiment', { raw: false });
        expect(getPath({ steps: { ai: { output: answer } } }, 'steps.ai.output.sentiment')).toBe('positive');
    });
});

describe('a list of name/value pairs', () => {
    it('reads as a two-column table whose values map by name', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        const value = { headers: [{ name: 'From', value: 'ada@example.com' }, { name: 'Subject', value: 'Invoice 7' }, { name: 'subject', value: 'second' }] };
        render(<OutputView value={value} basePath="steps.m.output" enableDrag onPickPath={onPick} />);
        expect(screen.getByRole('rowheader', { name: 'Subject' })).toBeTruthy();
        await user.click(screen.getByText('Invoice 7'));
        expect(onPick).toHaveBeenLastCalledWith('steps.m.output.headers[name="Subject"].value', { raw: false });
        // The runtime matches names without case: a second "subject" is reached by position.
        await user.click(screen.getByText('second'));
        expect(onPick).toHaveBeenLastCalledWith('steps.m.output.headers[2].value', { raw: false });
        const root = { steps: { m: { output: value } } };
        expect(getPath(root, 'steps.m.output.headers[name="Subject"].value')).toBe('Invoice 7');
        expect(getPath(root, 'steps.m.output.headers[2].value')).toBe('second');
    });
});
