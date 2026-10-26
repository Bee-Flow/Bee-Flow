import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { FieldChange } from '@/api/queries/automation/versions';
import FieldDiffTable from './FieldDiffTable';
import LineDiff from './LineDiff';

const many = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

describe('LineDiff', () => {
    it('shows line numbers and a +/- gutter', () => {
        const { container } = render(<LineDiff before={'a\nb\nc'} after={'a\nB\nc'} context={Infinity} />);
        const rows = Array.from(container.querySelectorAll('[data-kind]'));
        expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['same', 'del', 'add', 'same']);
        const del = within(rows[1] as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
        expect(del).toEqual(['2', '', '-', 'b']);
        const add = within(rows[2] as HTMLElement).getAllByRole('cell').map((c) => c.textContent);
        expect(add).toEqual(['', '2', '+', 'B']);
        expect(screen.getByText('Lines added: 1. Lines removed: 1.')).toBeTruthy();
    });

    it('folds unchanged lines and unfolds them on request', async () => {
        const user = userEvent.setup();
        const before = many(30).join('\n');
        const after = many(30).map((l, i) => (i === 14 ? 'changed' : l)).join('\n');
        render(<LineDiff before={before} after={after} />);
        expect(screen.queryByText('line 1')).toBeNull();
        const buttons = screen.getAllByRole('button', { name: /unchanged lines/ });
        expect(buttons.map((b) => b.textContent)).toEqual(['Show 11 unchanged lines', 'Show 12 unchanged lines']);
        await user.click(buttons[0]);
        expect(screen.getByText('line 1')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: /unchanged lines/ })).toHaveLength(1);
    });

    it('says when the text was cut at the server cap', () => {
        render(<LineDiff before="a" after="b" truncated />);
        expect(screen.getByText(/the end is not shown/)).toBeTruthy();
    });
});

const change = (over: Partial<FieldChange>): FieldChange => ({
    stepId: 's1', stepNumber: 1, stepLabel: 'Convert totals', change: 'changed', setting: 'code', settingLabel: 'Code',
    before: 'return 1;', after: 'return 2;', ...over,
});

describe('FieldDiffTable line changes', () => {
    it('offers "Show line changes" for a change that carries its full text, and opens the line diff', async () => {
        const user = userEvent.setup();
        render(<FieldDiffTable from={1} to={2} changes={[change({ beforeText: 'let a = 1;\nreturn a;', afterText: 'let a = 2;\nreturn a;' })]} />);
        expect(screen.queryByTestId('line-diff')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Show line changes' }));
        expect(screen.getByTestId('line-diff')).toBeTruthy();
        expect(screen.getByText('let a = 2;')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Hide line changes' }));
        expect(screen.queryByTestId('line-diff')).toBeNull();
    });

    it('offers nothing for a change without full text, and keeps the short cells', () => {
        render(<FieldDiffTable from={1} to={2} changes={[change({ setting: 'folder', settingLabel: 'Folder', before: 'Inbox', after: 'Archive' })]} />);
        expect(screen.queryByRole('button', { name: /line changes/ })).toBeNull();
        expect(screen.getByText('Inbox')).toBeTruthy();
        expect(screen.getByText('Archive')).toBeTruthy();
    });
});
