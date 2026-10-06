import type { ComponentType } from 'react';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonicalPath, getPath } from '@shared/expr/path.mjs';
import OutputView from '../OutputView';
import JsonTreeJs from '../debug/JsonTree';

/**
 * The Comes-in "Table" view maps a whole column or a single cell, and the Run
 * tab copies a value's path. Every path either one hands out must be one the
 * RUNTIME resolves (shared/expr/path.mjs getPath) — the keys real payloads
 * carry (`content-type`, `Story Points`, `@odata.etag`, `Größe`, "0") used to
 * be glued on with a dot: the preview showed the value, the run got nothing.
 */
const JsonTree = JsonTreeJs as unknown as ComponentType<Record<string, unknown>>;

const OUTPUT = {
    headers: { 'content-type': 'application/json', 'x-request-id': 'r1', Größe: 'XL', 0: 'zero' },
    rows: [
        { 'Story Points': 5, '@odata.etag': 'W/1', from: { emailAddress: { address: 'ada@example.com', 'display name': 'Ada' } }, tags: [{ 'tag-name': 'a' }] },
        { 'Story Points': 3, '@odata.etag': 'W/2', from: { emailAddress: { address: 'eve@example.com' } }, tags: [], extra: 'only here' },
    ],
};
const BASE = 'steps.src.output';
const ROOT = { steps: { src: { output: OUTPUT } } };

afterEach(cleanup);

function picked(onPick: ReturnType<typeof vi.fn>): string[] {
    return onPick.mock.calls.map(c => c[0] as string);
}

function expectResolvable(paths: string[]) {
    const bad = paths.filter(p => canonicalPath(p) !== p || getPath(ROOT, p) === undefined);
    expect(bad).toEqual([]);
}

describe('the Table view hands out runtime paths', () => {
    it('every field, column and cell, also after opening nested columns two levels down', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<OutputView value={OUTPUT} basePath={BASE} enableDrag onPickPath={onPick} />);
        await user.click(screen.getByRole('button', { name: 'Show fields' }));
        // `from` opened: its `emailAddress` column opens too (it used to stop at one level).
        const nested = screen.getAllByRole('button', { name: 'Show fields' });
        await user.click(nested[0]);
        for (const el of document.querySelectorAll('[draggable="true"]')) {
            await user.click(el as HTMLElement);
        }
        const paths = picked(onPick);
        expect(paths).toEqual(expect.arrayContaining([
            `${BASE}.headers["content-type"]`,
            `${BASE}.headers["Größe"]`,
            `${BASE}.headers[0]`,
            `${BASE}.rows[*]["Story Points"]`,
            `${BASE}.rows[0]["@odata.etag"]`,
            `${BASE}.rows[*].from.emailAddress.address`,
            `${BASE}.rows[1].from.emailAddress.address`,
            `${BASE}.rows[*].from.emailAddress["display name"]`,
            `${BASE}.rows[*].extra`,
        ]));
        expectResolvable(paths);
    });

    it('a list column opens into the columns of its items, quoted', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(<OutputView value={OUTPUT.rows} basePath={`${BASE}.rows`} enableDrag onPickPath={onPick} />);
        await user.click(screen.getByRole('button', { name: 'Open the list in Tags' }));
        const header = screen.getAllByRole('columnheader').find(h => within(h).queryByText('Tag name'));
        await user.click(header as HTMLElement);
        expect(picked(onPick).at(-1)).toBe(`${BASE}.rows[*].tags[*]["tag-name"]`);
        expectResolvable(picked(onPick));
    });
});

describe('a wide table inside a record', () => {
    it('scrolls sideways in its own box, so the record view keeps its width', () => {
        render(<OutputView value={OUTPUT} basePath={BASE} enableDrag onPickPath={vi.fn()} />);
        const box = screen.getByTestId('nested-table');
        expect(box.className).toContain('overflow-x-auto');
        expect(within(box).getByRole('table')).toBeTruthy();
    });

    it('a list that IS the output keeps the panel-wide scroller', () => {
        render(<OutputView value={OUTPUT.rows} basePath={`${BASE}.rows`} enableDrag onPickPath={vi.fn()} />);
        expect(screen.queryByTestId('nested-table')).toBeNull();
        expect(screen.getByRole('table')).toBeTruthy();
    });
});

describe('the Run tab copies runtime paths', () => {
    it('quotes the keys a dot cannot carry', async () => {
        const user = userEvent.setup();
        const onCopyPath = vi.fn();
        render(<JsonTree value={OUTPUT} basePath={BASE} onCopyPath={onCopyPath} maxInitialDepth={8} />);
        for (const b of screen.getAllByLabelText('Copy path')) await user.click(b);
        const paths = onCopyPath.mock.calls.map(c => c[0] as string);
        expect(paths).toEqual(expect.arrayContaining([
            `${BASE}.headers["content-type"]`,
            `${BASE}.rows[0]["Story Points"]`,
            `${BASE}.rows[0].from.emailAddress["display name"]`,
        ]));
        expectResolvable(paths);
    });
});
