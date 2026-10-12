import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PlanReview from './PlanReview';
import WorkModePicker from './WorkModePicker';
import ProposalCard from './ProposalCard';
import { reviewedProposal } from './proposalChanges';

afterEach(cleanup);

describe('assistant review controls', () => {
    it('opens supporting plan sections through their navigation links', () => {
        const { container } = render(<PlanReview plan={{ id: 'p', version: 1, status: 'review', title: 'Invoice plan', steps: ['Read invoices'], assumptions: ['Use the finance inbox'] }} onApprove={vi.fn()} onClose={vi.fn()} />);
        const cards = container.querySelectorAll('section details');
        expect(cards[0].open).toBe(true);
        expect(cards[1].open).toBe(false);
        fireEvent.click(screen.getByRole('link', { name: /what I assume/i }));
        expect(cards[1].open).toBe(true);
    });

    it('selects a work mode and remembers the large-change preference through the caller', () => {
        const onChange = vi.fn(), onAlwaysPlanLargeChange = vi.fn();
        render(<WorkModePicker value="approve" onChange={onChange} alwaysPlanLarge onAlwaysPlanLargeChange={onAlwaysPlanLargeChange} />);
        fireEvent.click(screen.getByRole('button'));
        fireEvent.click(screen.getByRole('checkbox'));
        expect(onAlwaysPlanLargeChange).toHaveBeenCalledWith(false);
        fireEvent.click(screen.getByRole('menuitemradio', { name: /only discuss/i }));
        expect(onChange).toHaveBeenCalledWith('discuss');
        expect(screen.queryByRole('menu')).toBeNull();
    });

    it('approves the displayed plan with pause enabled and comments on the precise line', () => {
        const onApprove = vi.fn(), onComment = vi.fn();
        render(<PlanReview plan={{ id: 'p1', version: 2, status: 'review', title: 'Read invoices', goal: 'Save extracted values', steps: ['Read the attachment'] }} onApprove={onApprove} onComment={onComment} onClose={vi.fn()} />);
        fireEvent.click(screen.getByRole('checkbox', { name: /pause after each step/i }));
        fireEvent.click(screen.getByRole('button', { name: /build this plan/i }));
        expect(onApprove).toHaveBeenCalledWith(true);
        fireEvent.click(screen.getByRole('button', { name: /comment on this line: Read the attachment/i }));
        expect(onComment).toHaveBeenCalledWith('steps', 0, 'Read the attachment');
    });

    it('shows real mapping values and applies only selected fields', () => {
        const baseDefinition = { trigger: { id: 't' }, steps: [{ id: 'mail', label: 'Email', settings: { to: { kind: 'ref', path: 'trigger.output.sender' }, subject: 'Old' } }] };
        const definition = structuredClone(baseDefinition);
        definition.steps[0].settings.to.path = 'trigger.output.recipient';
        definition.steps[0].settings.subject = 'New';
        const onApply = vi.fn();
        render(<ProposalCard proposal={{ id: 'p', baseDefinition, definition }} onApply={onApply} onDiscard={vi.fn()} onPreview={vi.fn()} realOutputById={new Map([['t', { sender: 'sender@example.test', recipient: 'recipient@example.test' }]])} />);
        expect(screen.getByText(/↳ sender@example.test/)).toBeTruthy();
        expect(screen.getByText(/↳ recipient@example.test/)).toBeTruthy();
        fireEvent.click(screen.getByRole('checkbox', { name: 'settings.to' }));
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
        // The card hands over the unticked fields; the shell reverts them on the
        // definition the server answers with (which holds the real table ids).
        const excluded = onApply.mock.calls[0][0];
        expect([...excluded]).toEqual([':mail:settings.to']);
        expect(reviewedProposal({ baseDefinition, definition }, excluded).steps[0].settings).toEqual({ to: baseDefinition.steps[0].settings.to, subject: 'New' });
        expect(baseDefinition.steps[0].settings.subject).toBe('Old');
    });
});

describe('proposal card', () => {
    it('says a yes in the chat applies nothing, and offers Apply and Discard (BFSF-486)', async () => {
        const user = userEvent.setup();
        const onApply = vi.fn(), onDiscard = vi.fn();
        const baseDefinition = { trigger: { id: 't', kind: 'manual' }, steps: [] };
        const definition = { ...baseDefinition, steps: [{ id: 's1', type: 'set', label: 'Email totals' }] };
        render(<ProposalCard proposal={{ id: 'p', baseDefinition, definition }} onApply={onApply} onDiscard={onDiscard} onPreview={vi.fn()} />);
        expect(screen.getByText(/does not apply this\. Press Apply/)).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Discard' }));
        expect(onDiscard).toHaveBeenCalledTimes(1);
        await user.click(screen.getByRole('button', { name: 'Apply' }));
        expect(onApply.mock.calls[0][0]).toBeInstanceOf(Set);
        expect(onApply.mock.calls[0][0].size).toBe(0);
    });
});
