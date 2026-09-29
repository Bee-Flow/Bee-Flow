import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import DangerZone, { inUsePayload } from './DangerZone';
import { adaptDatatableUsageRow } from './UsedByTab';

/**
 * Delete is gated on SEEING what depends on the thing, then on typing its
 * name. The server keeps its own 409 `in_use` guard; this component passes
 * `confirmedBreaking=true` only when the list on screen was non-empty and
 * the name was typed against it, and a 409 that comes back anyway re-shows
 * the server's list and asks for the name again.
 */

const DEP = { kind: 'automation', id: 'a1', title: 'Nightly sync', role: 'read', ownerId: 'u1' };

function arm(props = {}) {
    const onDelete = props.onDelete || vi.fn(async () => ({ ok: true }));
    const utils = render(<DangerZone entityName="Customers" kindLabel="table" usage={[]} {...props} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole('button', { name: /delete this table/i }));
    return { onDelete, ...utils };
}

describe('DangerZone — with dependents', () => {
    it('lists them, disables the button until the name is typed, then deletes with confirmedBreaking=true', async () => {
        const { onDelete } = arm({ usage: [DEP], currentUserId: 'u1' });
        expect(screen.getByTestId('danger-dependents')).toHaveTextContent(/one thing uses this/i);
        expect(screen.getByText('Nightly sync')).toBeInTheDocument();

        const confirm = screen.getByRole('button', { name: 'Delete for good' });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value: 'Custom' } });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value: 'Customers' } });
        expect(confirm).toBeEnabled();

        fireEvent.click(confirm);
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(true));
    });

    it('the dependents list follows the shared navigation rule (your own item is a button)', () => {
        const onNavigate = vi.fn();
        arm({ usage: [DEP], currentUserId: 'u1', onNavigate });
        fireEvent.click(screen.getByRole('button', { name: 'Nightly sync' }));
        expect(onNavigate).toHaveBeenCalledWith('studio/routines/a1');
    });

    it('counts many', () => {
        arm({ usage: [DEP, { ...DEP, id: 'a2', title: 'Weekly digest' }] });
        expect(screen.getByTestId('danger-dependents')).toHaveTextContent(/2 things use this/i);
    });

    it('reads legacy rows through adapt', () => {
        arm({
            usage: [{ automationId: 'a1', automationTitle: 'Nightly sync', automationOwner: 'u9', mode: 'read', columns: [] }],
            adapt: adaptDatatableUsageRow, currentUserId: 'u1',
        });
        expect(screen.getByText('Nightly sync')).toBeInTheDocument();
        expect(screen.getByText(/someone else/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete for good' })).toBeDisabled();
    });
});

describe('DangerZone — without dependents', () => {
    it('says nothing depends on it, needs no name, and deletes with confirmedBreaking=false', async () => {
        const { onDelete } = arm({ usage: [] });
        expect(screen.getByTestId('danger-unused')).toBeInTheDocument();
        expect(screen.queryByLabelText(/type the name/i)).toBeNull();
        const confirm = screen.getByRole('button', { name: 'Delete for good' });
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(false));
    });

    it('while the list is still unknown (null) it asks for the name and does NOT pre-confirm breaking', async () => {
        // The server keeps its guard: a person never confirms breaking
        // something they were not shown.
        const { onDelete } = arm({ usage: null });
        expect(screen.getByTestId('danger-checking')).toBeInTheDocument();
        const confirm = screen.getByRole('button', { name: 'Delete for good' });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value: 'Customers' } });
        fireEvent.click(confirm);
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(false));
    });

    it('requireName keeps the name gate even with no dependents (a table’s rows are data)', async () => {
        const { onDelete } = arm({ usage: [], requireName: true });
        expect(screen.getByTestId('danger-unused')).toBeInTheDocument();
        const confirm = screen.getByRole('button', { name: 'Delete for good' });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value: 'Customers' } });
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(false));
    });

    it('cancel collapses back to the link and forgets what was typed', () => {
        arm({ usage: [DEP] });
        fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value: 'Customers' } });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(screen.getByRole('button', { name: /delete this table/i })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /delete this table/i }));
        expect(screen.getByLabelText(/type the name/i)).toHaveValue('');
    });
});

describe('DangerZone — the 409 in_use round trip', () => {
    const SERVER_USAGE = [{ automationId: 'a7', automationTitle: 'Late arrival', automationOwner: 'u1', mode: 'write', columns: ['email'] }];

    it('a thrown 409 re-shows the server’s list and asks for the name again', async () => {
        const err = Object.assign(new Error('Routines still use this datatable'), { status: 409, code: 'in_use', body: { code: 'in_use', usage: SERVER_USAGE } });
        const onDelete = vi.fn()
            .mockRejectedValueOnce(err)
            .mockResolvedValueOnce({ ok: true });
        arm({ usage: [], onDelete, adapt: adaptDatatableUsageRow, currentUserId: 'u1' });

        fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        await waitFor(() => expect(onDelete).toHaveBeenCalledWith(false));

        // The list the server sent is now on screen, adapted, and the button
        // is locked behind the name again.
        expect(await screen.findByText('Late arrival')).toBeInTheDocument();
        expect(screen.getByTestId('danger-dependents')).toBeInTheDocument();
        expect(screen.getByText(/still uses this/i)).toBeInTheDocument();
        const confirm = screen.getByRole('button', { name: 'Delete for good' });
        expect(confirm).toBeDisabled();

        fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value: 'Customers' } });
        fireEvent.click(confirm);
        await waitFor(() => expect(onDelete).toHaveBeenLastCalledWith(true));
        expect(onDelete).toHaveBeenCalledTimes(2);
    });

    it('a resolved {code:"in_use", usage} payload is handled the same way', async () => {
        const onDelete = vi.fn(async () => ({ code: 'in_use', usage: [DEP] }));
        arm({ usage: [], onDelete });
        fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        expect(await screen.findByText('Nightly sync')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete for good' })).toBeDisabled();
    });

    it('any other failure is shown as text and the button comes back', async () => {
        const onDelete = vi.fn(async () => { throw new Error('Could not delete the table'); });
        arm({ usage: [], onDelete });
        fireEvent.click(screen.getByRole('button', { name: 'Delete for good' }));
        expect(await screen.findByText('Could not delete the table')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Delete for good' })).toBeEnabled();
    });

    it('inUsePayload recognises the three shapes and nothing else', () => {
        expect(inUsePayload({ code: 'in_use', usage: [1] })).toEqual([1]);
        expect(inUsePayload({ body: { code: 'in_use', usage: [2] } })).toEqual([2]);
        expect(inUsePayload({ status: 409, body: { usage: [3] } })).toEqual([3]);
        expect(inUsePayload({ status: 409, body: { code: 'breaking_change' } })).toBeNull();
        expect(inUsePayload(new Error('x'))).toBeNull();
        expect(inUsePayload(null)).toBeNull();
    });
});

/**
 * `unchecked` — the other half of a 409, and the one that vanishes quietly.
 * An empty list only means "nothing uses this" when everything was actually
 * looked at; with a kind left unanswered the card must withhold that claim.
 * `defaultArmed` / `onCancel` exist for a host that is already a delete-only
 * surface (a dialog), where the collapsed link is a second click asking the
 * question the surface was opened to ask.
 */
describe('DangerZone — kinds that could not be checked', () => {
    it('withholds the "nothing uses this" claim', () => {
        arm({ usage: [], unchecked: ['agent'] });
        expect(screen.queryByTestId('danger-unused')).toBeNull();
        expect(screen.getByTestId('danger-unchecked')).toHaveTextContent(/not everything could be checked/i);
    });

    it('says it over a NON-EMPTY list too — a found row is not a complete list', () => {
        // The state that is standard rather than exceptional: one Solution
        // found, one kind unanswered. "One thing uses this and will start
        // failing:" over a list of one reads as the whole truth — a found row
        // is the shape in which a reader is MOST sure they are seeing
        // everything — so the incomplete line has to survive here as well.
        arm({ usage: [DEP], unchecked: ['agent'] });
        expect(screen.getByTestId('danger-dependents')).toBeInTheDocument();
        // Not the empty-list wording…
        expect(screen.queryByTestId('danger-unchecked')).toBeNull();
        // …but the list is still marked incomplete.
        expect(screen.getByTestId('danger-dependents-incomplete'))
            .toHaveTextContent(/not the whole story/i);
    });

    it('a complete non-empty list says nothing extra', () => {
        arm({ usage: [DEP], unchecked: [] });
        expect(screen.getByTestId('danger-dependents')).toBeInTheDocument();
        expect(screen.queryByTestId('danger-dependents-incomplete')).toBeNull();
    });

    it('omitting the prop keeps the old wording exactly', () => {
        arm({ usage: [] });
        expect(screen.getByTestId('danger-unused')).toHaveTextContent(/nothing uses this/i);
        expect(screen.queryByTestId('danger-unchecked')).toBeNull();
    });
});

describe('DangerZone — as a dialog body', () => {
    it('defaultArmed skips the collapsed link', () => {
        render(<DangerZone entityName="Customers" kindLabel="table" usage={[]} defaultArmed onDelete={vi.fn()} />);
        expect(screen.getByRole('button', { name: 'Delete for good' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /delete this table/i })).toBeNull();
    });

    it('Cancel calls onCancel so the host can close itself', () => {
        const onCancel = vi.fn();
        render(<DangerZone entityName="Customers" kindLabel="table" usage={[]} defaultArmed onCancel={onCancel} onDelete={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalled();
    });
});
