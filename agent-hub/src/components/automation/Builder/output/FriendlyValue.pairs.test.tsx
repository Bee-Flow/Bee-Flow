import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import FriendlyValue from './FriendlyValue';

/**
 * Only a REAL list of name/value pairs (mail headers, tags: exactly a name and
 * a value) reads as a two-column name/value table. A file list
 * (`{ name, content }`), comments (`{ name, text }`) or form rows with a type
 * beside label and value are records: a table with a header per field, whose
 * columns map as a whole (`files[*].content`, "run once per row") and whose
 * every field stays on screen.
 */
afterEach(cleanup);

const BASE = 'steps.f.output';
const header = (label: string) => screen.getAllByRole('columnheader').find(h => within(h).queryByText(label)) as HTMLElement;

function renderPicking(value: unknown) {
    const onPick = vi.fn();
    render(<FriendlyValue value={value} map={{ path: BASE, onPick }} allowExpand />);
    return onPick;
}

describe('a list that only looks like name/value pairs', () => {
    it('a file list is a record table: its content column maps as a whole, each cell by position', async () => {
        const user = userEvent.setup();
        const files = [{ name: 'a.txt', content: 'alpha' }, { name: 'b.txt', content: 'beta' }, { name: 'a.txt', content: 'again' }];
        const onPick = renderPicking({ files });
        expect(screen.queryAllByRole('rowheader')).toHaveLength(0);
        await user.click(header('Content'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.files[*].content`, { raw: false });
        expect(screen.getByRole('button', { name: "Choose how to use every row's Content" })).toBeTruthy();
        await user.click(screen.getByText('again'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.files[2].content`, { raw: false });
        const root = { steps: { f: { output: { files } } } };
        expect(getPath(root, `${BASE}.files[*].content`)).toEqual(['alpha', 'beta', 'again']);
    });

    it('comments ({ name, text }) keep their text column', async () => {
        const user = userEvent.setup();
        const onPick = renderPicking({ comments: [{ name: 'Ann', text: 'Looks good' }, { name: 'Bob', text: 'Ship it' }] });
        await user.click(header('Text'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.comments[*].text`, { raw: false });
    });

    it('form rows with a type beside label and value show the type too', () => {
        renderPicking({ rows: [{ label: 'Email', value: 'x@y.z', type: 'email' }, { label: 'Name', value: 'X', type: 'text' }] });
        expect(header('Type')).toBeTruthy();
        expect(screen.getByText('email')).toBeTruthy();
        expect(screen.getByText('text')).toBeTruthy();
    });
});

describe('a real list of name/value pairs', () => {
    it('keeps its by-name values and also maps a whole column', async () => {
        const user = userEvent.setup();
        const headers = [{ name: 'From', value: 'ada@example.com' }, { name: 'Subject', value: 'Invoice 7' }];
        const onPick = renderPicking({ headers });
        expect(screen.getByRole('rowheader', { name: 'Subject' })).toBeTruthy();
        await user.click(screen.getByText('Invoice 7'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.headers[name="Subject"].value`, { raw: false });
        await user.click(header('Value'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.headers[*].value`, { raw: false });
        await user.click(screen.getByRole('button', { name: "Choose how to use every row's Name" }));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}.headers[*].name`, { raw: false });
        const root = { steps: { f: { output: { headers } } } };
        expect(getPath(root, `${BASE}.headers[*].value`)).toEqual(['ada@example.com', 'Invoice 7']);
    });

    it('a whole output that is such a list still has a list-level path', async () => {
        const user = userEvent.setup();
        const onPick = renderPicking([{ Key: 'env', Value: 'prod' }, { Key: 'team', Value: 'core' }]);
        expect(screen.getByRole('rowheader', { name: 'env' })).toBeTruthy();
        await user.click(header('Value'));
        expect(onPick).toHaveBeenLastCalledWith(`${BASE}[*].Value`, { raw: false });
    });
});
