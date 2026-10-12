/**
 * The outputs bar under a meeting's tags (M2).
 *
 * What is worth testing here is not that chips render — it is that the bar
 * never says "nothing picks this meeting up" about a list it could not read.
 * That sentence sits one scroll above a delete button, and it is the one
 * claim on this screen that a person will act on.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import MeetingOutputsBar, { orderRows } from './MeetingOutputsBar';

vi.mock('../../../hooks/useTranslation', () => ({
    default: () => ({
        t: (key, fallback, vars) => {
            let out = fallback || key;
            for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
            return out;
        },
    }),
}));

const kbRow = (over = {}) => ({ kind: 'kb', id: 'kb-1', title: 'Sales', role: 'contains', siteLabel: 'sales', ownerId: 'me', ...over });
const autoRow = (over = {}) => ({ kind: 'automation', id: 'a-1', title: 'Notify the team', role: 'read', ownerId: 'me', ...over });
const nbRow = (over = {}) => ({ kind: 'notebook', id: 'nb-1', title: 'Q3 research', role: 'contains', ownerId: 'me', ...over });

describe('MeetingOutputsBar', () => {
    it('says it is still checking while the list is null', () => {
        render(<MeetingOutputsBar rows={null} />);
        expect(screen.getByTestId('meeting-outputs-loading')).toBeTruthy();
        expect(screen.queryByTestId('meeting-outputs-empty')).toBeNull();
    });

    it('lists what happens, knowledge bases first', () => {
        render(<MeetingOutputsBar rows={[nbRow(), autoRow(), kbRow()]} currentUserId="me" />);
        const chips = screen.getAllByTestId('meeting-output-chip');
        expect(chips.map((c) => c.textContent)).toEqual([
            expect.stringContaining('Sales'),
            expect.stringContaining('Notify the team'),
            expect.stringContaining('Q3 research'),
        ]);
    });

    it('an empty list only says "nothing picks this up" when nothing went unanswered', () => {
        const { rerender } = render(<MeetingOutputsBar rows={[]} />);
        expect(screen.getByTestId('meeting-outputs-empty').textContent).toMatch(/Nothing picks this meeting up/i);

        // The same empty array, but the server could not check notebooks. The
        // sentence must change — this is the fail-open the bar guards.
        rerender(<MeetingOutputsBar rows={[]} unchecked={['notebook']} />);
        expect(screen.getByTestId('meeting-outputs-empty').textContent).not.toMatch(/Nothing picks this meeting up/i);
        expect(screen.getByTestId('meeting-outputs-unchecked').textContent).toMatch(/notebooks/i);
    });

    it('a failed read says so and never reads as "nothing"', () => {
        render(<MeetingOutputsBar rows={[]} error="boom" />);
        expect(screen.getByRole('status').textContent).toMatch(/Could not check/i);
        expect(screen.getByTestId('meeting-outputs-empty').textContent).not.toMatch(/Nothing picks this meeting up/i);
    });

    it('warns about unchecked kinds even when there ARE rows', () => {
        // A partial list is not a complete one just because it is non-empty.
        render(<MeetingOutputsBar rows={[kbRow()]} unchecked={['automation']} currentUserId="me" />);
        expect(screen.getByTestId('meeting-outputs-unchecked').textContent).toMatch(/automations/i);
        expect(screen.getAllByTestId('meeting-output-chip')).toHaveLength(1);
    });

    it('an automation with no filter says it runs on every meeting', () => {
        render(<MeetingOutputsBar rows={[autoRow({ unfiltered: true })]} currentUserId="me" />);
        expect(screen.getByTestId('meeting-output-chip').textContent).toMatch(/on every meeting/i);
    });

    it('navigates in-app for your own row', () => {
        const onNavigate = vi.fn();
        render(<MeetingOutputsBar rows={[kbRow()]} currentUserId="me" onNavigate={onNavigate} />);
        fireEvent.click(within(screen.getByTestId('meeting-output-chip')).getByText('Sales'));
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/kb-1');
    });

    it('somebody else’s row is plain text, not a link that lands on nothing', () => {
        const onNavigate = vi.fn();
        render(<MeetingOutputsBar rows={[kbRow({ ownerId: 'someone-else', title: null })]} currentUserId="me" onNavigate={onNavigate} />);
        const chip = screen.getByTestId('meeting-output-chip');
        expect(chip.tagName).toBe('SPAN');
        expect(chip.textContent).toMatch(/Someone else/i);
        fireEvent.click(chip);
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('renders nothing clickable when there is no router to navigate with', () => {
        render(<MeetingOutputsBar rows={[kbRow()]} currentUserId="me" />);
        expect(screen.getByTestId('meeting-output-chip').tagName).toBe('SPAN');
    });

    it('tells a base that COLLECTS the tag apart from one holding filed lines (M4)', () => {
        // Same knowledge base, two different claims. Without the count they
        // are two identical chips, and the second one silently becomes a
        // duplicate of the first in the reader's head.
        render(
            <MeetingOutputsBar
                rows={[kbRow(), kbRow({ siteLabel: undefined, lineCount: 2 })]}
                currentUserId="me"
            />,
        );
        const chips = screen.getAllByTestId('meeting-output-chip').map((c) => c.textContent);
        expect(chips[0]).toContain('sales');
        expect(chips[1]).toContain('2 knowledge lines');
    });

    it('one filed line gets the singular sentence, never a bolted-on "s"', () => {
        render(<MeetingOutputsBar rows={[kbRow({ siteLabel: undefined, lineCount: 1 })]} currentUserId="me" />);
        expect(screen.getByTestId('meeting-output-chip').textContent).toContain('1 knowledge line');
    });

    it('orderRows keeps a kind it does not know at the end and is otherwise stable', () => {
        const unknown = { kind: 'wormhole', id: 'w' };
        expect(orderRows([unknown, nbRow(), kbRow()]).map((r) => r.kind))
            .toEqual(['kb', 'notebook', 'wormhole']);
        // Two rows of the same kind keep their incoming order.
        const a = kbRow({ id: 'kb-a' });
        const b = kbRow({ id: 'kb-b' });
        expect(orderRows([a, b]).map((r) => r.id)).toEqual(['kb-a', 'kb-b']);
        expect(orderRows(null)).toEqual([]);
        expect(orderRows([null, undefined, a])).toHaveLength(1);
    });
});
