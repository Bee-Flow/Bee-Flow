import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import FriendlyValue from './FriendlyValue';

/**
 * `.length` of a string is the string's length at run time (path.mjs
 * stepInto), never a `length` key of the JSON the text encodes. The output
 * view shows JSON text as what it encodes, so it must not hand out a path to
 * such a key: clicking "Length: 120" used to map `body.length`, which ran as
 * the text's 28 characters.
 */
afterEach(cleanup);

const BASE = 'steps.h.output';
const BODY = '{"length":120,"width":40}';

describe('a `length` key inside JSON text', () => {
    it('is shown, but maps nothing; its sibling maps to what the run reads', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        const value = { status: 200, body: BODY };
        render(<FriendlyValue value={value} map={{ path: BASE, onPick }} allowExpand />);
        expect(screen.getByText('120')).toBeTruthy();
        await user.click(screen.getByText('Length:'));
        await user.click(screen.getByText('120'));
        expect(onPick).not.toHaveBeenCalled();
        await user.click(screen.getByText('40'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.body.width`, { raw: false });
        const root = { steps: { h: { output: value } } };
        expect(getPath(root, `${BASE}.body.width`)).toBe(40);
        for (const [p] of onPick.mock.calls) expect(p).not.toMatch(/\.length$/);
    });

    it('a record keeps its `length` key mappable', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<FriendlyValue value={{ length: 120 }} map={{ path: BASE, onPick }} allowExpand />);
        await user.click(screen.getByText('120'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.length`, { raw: false });
    });

    it('a table of JSON-text rows has no Length column', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        const rows = ['{"length":5,"name":"a"}', '{"length":7,"name":"b"}'];
        render(<FriendlyValue value={{ rows }} map={{ path: BASE, onPick }} allowExpand />);
        const headers = screen.getAllByRole('columnheader').map(h => h.textContent);
        expect(headers.some(h => /Name/.test(h || ''))).toBe(true);
        expect(headers.some(h => /Length/.test(h || ''))).toBe(false);
        await user.click(screen.getByText('b'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.rows[1].name`, { raw: false });
        expect(getPath({ steps: { h: { output: { rows } } } }, `${BASE}.rows[1].name`)).toBe('b');
    });
});
