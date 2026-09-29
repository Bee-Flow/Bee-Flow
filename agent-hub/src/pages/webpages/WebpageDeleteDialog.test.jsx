import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Deleting a webpage — the three answers, kept apart (W5 deel C).
 *
 *   BLOCKED BY USE          something was found → the list is shown, the name
 *                           is asked, and the request carries the confirmation
 *                           the server's 409 asked for.
 *   BLOCKED BY UNREADABILITY nothing was found and not everything was looked
 *                           at → the dialog must NOT say "nothing uses this".
 *                           This is the one that disappears quietly: an empty
 *                           list plus a lost `unchecked` reads as consent.
 *   FREE                    checked and empty → no name, no confirmation flag.
 *
 * Plus the two things that make the first two survive the round trip: a
 * usage read that FAILED is itself "could not check" (every kind of it), and
 * a 409 that comes back anyway hands over its own fresher `unchecked`.
 */

const authFetch = vi.fn();
vi.mock('../../utils/helpers', () => ({
    API_BASE: 'https://host.example',
    authFetch: (...args) => authFetch(...args),
}));

import WebpageDeleteDialog from './WebpageDeleteDialog';

const PAGE = { id: 'wp1', name: 'Prijslijst', userId: 'u1' };
const SOLUTION = {
    kind: 'solution', id: 'proj-1', title: 'Offertes', role: 'contains', ownerId: 'u1', lastAt: null,
};

const ok = (body) => ({ ok: true, status: 200, json: async () => body });
const fail = (status, body) => ({ ok: false, status, json: async () => body });

/** Route by URL: the usage GET answers `usage`, the DELETE answers `del`. */
function routes({ usage = ok({ usage: [], unchecked: [] }), del = ok({ success: true }) } = {}) {
    const calls = { usage: [], del: [] };
    authFetch.mockImplementation(async (url, opts = {}) => {
        if (String(url).endsWith('/usage')) {
            calls.usage.push(url);
            if (typeof usage === 'function') return usage(url);
            return usage;
        }
        calls.del.push({ url, method: opts.method });
        if (typeof del === 'function') return del(calls.del.length);
        return del;
    });
    return calls;
}

function open(props = {}) {
    const onDeleted = props.onDeleted || vi.fn();
    const onClose = props.onClose || vi.fn();
    const utils = render(
        <WebpageDeleteDialog webpage={PAGE} currentUserId="u1" {...props} onDeleted={onDeleted} onClose={onClose} />,
    );
    return { ...utils, onDeleted, onClose };
}

const confirmButton = () => screen.getByRole('button', { name: 'Delete for good' });
const typeName = (value) => fireEvent.change(screen.getByLabelText(/type the name/i), { target: { value } });

beforeEach(() => { authFetch.mockReset(); });

describe('blocked by use', () => {
    it('shows what holds the page, says deleting does not stop it, and asks for the name', async () => {
        const calls = routes({ usage: ok({ usage: [SOLUTION], unchecked: [], complete: true }) });
        open();

        expect(await screen.findByText('Offertes')).toBeInTheDocument();
        expect(screen.getByTestId('webpage-delete-does-not-stop')).toHaveTextContent(/not announced and not undone/i);
        expect(screen.queryByTestId('webpage-delete-unchecked')).toBeNull();
        expect(screen.queryByTestId('danger-unused')).toBeNull();

        expect(confirmButton()).toBeDisabled();
        typeName('Prijslijst');
        fireEvent.click(confirmButton());

        // Shown the list, typed the name → the confirmation the 409 asks for.
        await waitFor(() => expect(calls.del).toHaveLength(1));
        expect(calls.del[0].method).toBe('DELETE');
        expect(calls.del[0].url).toBe('https://host.example/api/webpages/wp1?confirm=1');
    });
});

describe('blocked by unreadability', () => {
    it('never says "nothing uses this" when a kind could not be checked', async () => {
        routes({ usage: ok({ usage: [], unchecked: ['agent'], complete: false }) });
        open();

        expect(await screen.findByTestId('webpage-delete-unchecked')).toHaveTextContent(/agents/i);
        // The half of the sentence the shared card owns.
        expect(screen.getByTestId('danger-unchecked')).toHaveTextContent(/not everything could be checked/i);
        expect(screen.queryByTestId('danger-unused')).toBeNull();
        // And the other half: with nothing FOUND, the intro may not pretend a
        // scan succeeded.
        expect(screen.getByTestId('webpage-delete-unknown')).toHaveTextContent(/did not finish/i);
        expect(screen.queryByTestId('webpage-delete-does-not-stop')).toBeNull();
    });

    it('the FIRST press asks the server; only the second one confirms', async () => {
        // `?confirm=1` tells the server to skip its check. An `unchecked` list
        // is permanently non-empty here (two kinds can never be answered), so
        // OR-ing it into the flag would send EVERY first press pre-confirmed
        // and retire the guard for this product entirely — a colleague filing
        // the page into a Solution in the seconds after the list loaded would
        // never be caught. So: ask, be refused, be shown the answer, confirm.
        const calls = routes({
            usage: ok({ usage: [], unchecked: ['chat', 'agent'] }),
            del: (n) => (n === 1
                ? fail(409, {
                    error: 'Could not check what uses this webpage',
                    code: 'in_use', usage: [], unchecked: ['chat', 'agent'], complete: false,
                })
                : ok({ success: true })),
        });
        open();

        await screen.findByTestId('webpage-delete-unchecked');
        expect(confirmButton()).toBeDisabled();
        typeName('Prijslijst');
        fireEvent.click(confirmButton());

        await waitFor(() => expect(calls.del).toHaveLength(1));
        expect(calls.del[0].url).toBe('https://host.example/api/webpages/wp1',
            'the first request must let the server do its own check');

        // The refusal came back: the card cleared the name and asks again.
        await screen.findByText(/type the name again/i);
        typeName('Prijslijst');
        fireEvent.click(confirmButton());

        await waitFor(() => expect(calls.del).toHaveLength(2));
        expect(calls.del[1].url).toBe('https://host.example/api/webpages/wp1?confirm=1');
    });

    it('a refusal that arrives between load and press is not pressed through', async () => {
        // The TOCTOU the two-step exists for: the list said "nothing", and by
        // the time the button was pressed a Solution had taken the page.
        const calls = routes({
            usage: ok({ usage: [], unchecked: ['agent'] }),
            del: (n) => (n === 1
                ? fail(409, {
                    error: 'This webpage is still in use',
                    code: 'in_use', usage: [SOLUTION], unchecked: ['agent'], complete: false,
                })
                : ok({ success: true })),
        });
        const { onDeleted } = open();

        await screen.findByTestId('webpage-delete-unchecked');
        typeName('Prijslijst');
        fireEvent.click(confirmButton());

        // The Solution the first list never had is now on screen, and nothing
        // was deleted.
        expect(await screen.findByText('Offertes')).toBeInTheDocument();
        expect(onDeleted).not.toHaveBeenCalled();
        expect(calls.del).toHaveLength(1);
    });

    it('a usage read that FAILED is every kind unchecked, not an empty list', async () => {
        routes({ usage: fail(500, { error: 'nope' }) });
        open();

        const line = await screen.findByTestId('webpage-delete-unchecked');
        expect(line).toHaveTextContent(/solutions/i);
        expect(line).toHaveTextContent(/chats/i);
        expect(line).toHaveTextContent(/agents/i);
        expect(screen.getByTestId('webpage-delete-unreadable')).toBeInTheDocument();
        expect(screen.queryByTestId('danger-unused')).toBeNull();
    });
});

describe('free', () => {
    it('checked and empty: no name, no confirmation flag, and the page is reported gone', async () => {
        const calls = routes({ usage: ok({ usage: [], unchecked: [], complete: true }) });
        const { onDeleted } = open();

        expect(await screen.findByTestId('danger-unused')).toHaveTextContent(/nothing uses this/i);
        expect(screen.queryByLabelText(/type the name/i)).toBeNull();
        expect(screen.queryByTestId('webpage-delete-unchecked')).toBeNull();
        expect(screen.queryByTestId('webpage-delete-unreadable')).toBeNull();

        fireEvent.click(confirmButton());
        await waitFor(() => expect(calls.del).toHaveLength(1));
        expect(calls.del[0].url).toBe('https://host.example/api/webpages/wp1',
            'nothing was shown to break, so nothing is confirmed — the server keeps its own guard');
        await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('wp1'));
    });
});

describe('the server refuses anyway', () => {
    it('takes the 409\'s own list AND its unchecked kinds, then confirms on the second press', async () => {
        const calls = routes({
            usage: ok({ usage: [], unchecked: [], complete: true }),
            del: (n) => (n === 1
                ? fail(409, { code: 'in_use', error: 'This webpage is still in use', usage: [SOLUTION], unchecked: ['agent'] })
                : ok({ success: true })),
        });
        const { onDeleted } = open();

        await screen.findByTestId('danger-unused');
        fireEvent.click(confirmButton());

        // The fresher list wins, and the kinds it could not check travel with it.
        expect(await screen.findByText('Offertes')).toBeInTheDocument();
        expect(screen.getByTestId('webpage-delete-unchecked')).toHaveTextContent(/agents/i);
        expect(onDeleted).not.toHaveBeenCalled();

        typeName('Prijslijst');
        fireEvent.click(confirmButton());
        await waitFor(() => expect(calls.del).toHaveLength(2));
        expect(calls.del[1].url).toBe('https://host.example/api/webpages/wp1?confirm=1');
        await waitFor(() => expect(onDeleted).toHaveBeenCalledWith('wp1'));
    });

    it('a 409 it cannot read reports every kind as unchecked rather than none', async () => {
        routes({
            usage: ok({ usage: [], unchecked: [], complete: true }),
            del: fail(409, null),
        });
        open();

        await screen.findByTestId('danger-unused');
        fireEvent.click(confirmButton());

        const line = await screen.findByTestId('webpage-delete-unchecked');
        expect(line).toHaveTextContent(/solutions/i);
        expect(screen.getByTestId('webpage-delete-unreadable')).toBeInTheDocument();
        expect(screen.queryByTestId('danger-unused')).toBeNull();
    });
});

describe('cancelling', () => {
    it('closes the dialog instead of dropping back onto a collapsed link', async () => {
        routes();
        const { onClose } = open();
        await screen.findByTestId('danger-unused');
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onClose).toHaveBeenCalled();
    });
});
