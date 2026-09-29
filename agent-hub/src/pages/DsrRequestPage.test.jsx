import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';

/**
 * The PUBLIC data-subject page (no account, no auth header). Pinned here:
 *   - the identity link from the acknowledgement e-mail (`?token=…&id=…`)
 *     posts to /api/dsr/requests/:id/verify and says the same neutral thing
 *     whatever the server answers — a miss must not reveal that a request
 *     with that id exists (BFSF-441);
 *   - the deadline (`due_at`) is shown after submitting and in the status
 *     check, with the Art. 12(3) extension named when there is one.
 */

vi.mock('../hooks/useTranslation', () => {
    const useTranslation = () => ({
        t: (key, fallback, vars) => {
            const base = typeof fallback === 'string' ? fallback : key;
            const params = typeof fallback === 'string' ? vars : fallback;
            return params ? Object.entries(params).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), base) : base;
        },
        locale: 'en',
        resolvedLocale: 'en',
    });
    return { default: useTranslation, useTranslation };
});

const { default: DsrRequestPage, readVerifyParams, formatDueDate } = await import('./DsrRequestPage');

const fetchMock = vi.fn();

function reply(ok, body, status) {
    return Promise.resolve({ ok, status: status ?? (ok ? 200 : 400), json: async () => body });
}

beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
});
afterEach(() => { cleanup(); });

describe('readVerifyParams', () => {
    it('reads token + numeric id, tolerates the other id spellings, and is null without a token', () => {
        expect(readVerifyParams('?token=abc&id=2038')).toEqual({ token: 'abc', id: '2038' });
        expect(readVerifyParams('?token=abc&request=2038')).toEqual({ token: 'abc', id: '2038' });
        expect(readVerifyParams('?token=abc&r=2038')).toEqual({ token: 'abc', id: '2038' });
        expect(readVerifyParams('?token=abc')).toEqual({ token: 'abc', id: null });
        expect(readVerifyParams('?token=abc&id=../../etc')).toEqual({ token: 'abc', id: null });
        expect(readVerifyParams('?id=2038')).toBeNull();
        expect(readVerifyParams('')).toBeNull();
        expect(readVerifyParams(undefined)).toBeNull();
    });
});

describe('DsrRequestPage — the identity link', () => {
    it('posts the token to /requests/:id/verify and confirms; the form is not shown while verifying', async () => {
        fetchMock.mockReturnValue(reply(true, { verified: true }));
        render(<DsrRequestPage search="?token=sig.ned&id=2038" />);
        expect(screen.getByTestId('dsr-verify-pending')).toBeTruthy();
        await screen.findByTestId('dsr-verify-ok');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toContain('/api/dsr/requests/2038/verify');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body)).toEqual({ token: 'sig.ned' });
        expect(screen.getByTestId('dsr-verify-ok')).toHaveTextContent('Identity confirmed');
    });

    it('a link without an id posts the token to the collection instead of failing on the spot', async () => {
        fetchMock.mockReturnValue(reply(true, { verified: true }));
        render(<DsrRequestPage search="?token=sig.ned" />);
        await screen.findByTestId('dsr-verify-ok');
        expect(String(fetchMock.mock.calls[0][0])).toContain('/api/dsr/requests/verify');
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ token: 'sig.ned' });
    });

    it('every miss reads the same: an unknown id, a spent token, a 200 with verified:false and a dead network', async () => {
        const seen = new Set();
        for (const answer of [
            () => reply(false, { error: 'invalid_token' }),
            () => reply(false, { error: 'not_found' }, 404),
            () => reply(true, { verified: false }),
            () => Promise.reject(new Error('network')),
        ]) {
            fetchMock.mockReset();
            fetchMock.mockImplementation(answer);
            render(<DsrRequestPage search="?token=spent&id=2038" />);
            const box = await screen.findByTestId('dsr-verify-failed');
            expect(box).toHaveTextContent('This link could not be used');
            seen.add(box.textContent);
            // Nothing about the request itself leaks into the page.
            expect(document.body.textContent).not.toMatch(/invalid_token|not_found|#2038/);
            cleanup();
        }
        expect(seen.size).toBe(1);
    });

    it('without a token the page is the ordinary request form, and nothing is posted', () => {
        render(<DsrRequestPage search="" />);
        expect(screen.queryByTestId('dsr-verify-pending')).toBeNull();
        expect(screen.queryByTestId('dsr-verify-ok')).toBeNull();
        expect(screen.queryByTestId('dsr-verify-failed')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('DsrRequestPage — the deadline', () => {
    it('formatDueDate renders a date and swallows junk', () => {
        expect(formatDueDate('2026-09-11T14:02:00Z', 'en')).toMatch(/^11 Sept? 2026$/);
        expect(formatDueDate('not-a-date', 'en')).toBe('');
        expect(formatDueDate(null, 'en')).toBe('');
    });

    it('after submitting, the reference number and "answer expected by" are shown', async () => {
        fetchMock.mockReturnValue(reply(true, { id: 2044, ack: 'A confirmation has been e-mailed.', due_at: '2026-10-14T08:51:00Z' }));
        render(<DsrRequestPage search="" />);
        fireEvent.change(screen.getByPlaceholderText(/@/), { target: { value: 'k@ziggo.nl' } });
        fireEvent.submit(screen.getByPlaceholderText(/@/).closest('form'));
        const due = await screen.findByTestId('dsr-submitted-due');
        expect(due).toHaveTextContent('Answer expected by');
        expect(due).toHaveTextContent('14 Oct 2026');
        expect(screen.getByText('#2044')).toBeTruthy();
    });

    it('the status check shows the deadline, names an extension, and drops the date once the request is closed', async () => {
        fetchMock.mockReturnValue(reply(true, { id: 2038, status: 'in_progress', due_at: '2026-09-11T14:02:00Z', extended_until: '2026-11-10T14:02:00Z' }));
        render(<DsrRequestPage search="" />);
        const forms = document.querySelectorAll('form');
        fireEvent.submit(forms[forms.length - 1]);
        const line = await screen.findByTestId('dsr-check-due');
        expect(line).toHaveTextContent('10 Nov 2026');            // the extension wins over due_at
        expect(line).toHaveTextContent('deadline extended (Art. 12(3))');

        cleanup();
        fetchMock.mockReturnValue(reply(true, { id: 2037, status: 'fulfilled', due_at: '2026-09-11T14:02:00Z' }));
        render(<DsrRequestPage search="" />);
        const forms2 = document.querySelectorAll('form');
        fireEvent.submit(forms2[forms2.length - 1]);
        await screen.findByTestId('dsr-check-result');
        expect(screen.queryByTestId('dsr-check-due')).toBeNull();
    });

    it('an unknown reference number says so without echoing the server error', async () => {
        fetchMock.mockReturnValue(reply(false, { error: 'not_found' }, 404));
        render(<DsrRequestPage search="" />);
        const forms = document.querySelectorAll('form');
        fireEvent.submit(forms[forms.length - 1]);
        const box = await screen.findByTestId('dsr-check-result');
        expect(box).toHaveTextContent('No request found for that reference number and email.');
        await waitFor(() => expect(box.textContent).not.toContain('not_found'));
    });
});
