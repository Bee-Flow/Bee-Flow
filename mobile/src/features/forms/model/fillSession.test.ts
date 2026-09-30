/** The filling screen's journey: page one, the wait, page N, the end — and the dead ends. */

import { applySession, checkAgain, failedToStart, INITIAL_FILL, resuming, slowed, started, submitted } from './fillSession';
import type { FillForm } from './fillTypes';
import { newNonce, nextPollDelay, POLL_MAX_MS, POLL_MIN_MS, submitDelay } from './fillValues';

const page = (title: string, extra: Partial<FillForm> = {}): FillForm => ({
    title,
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thanks, all in.',
    theme: { primary: '#0F766E' },
    fields: [],
    multiPage: false,
    ...extra,
});

describe('a single-page form', () => {
    it('shows the page, then its thank-you the moment the answers are taken', () => {
        const shown = started(INITIAL_FILL, { form: page('Intake'), csrf: 'c1', issuedAt: 1000 }, 5000);
        expect(shown).toMatchObject({ status: 'form', csrf: 'c1', issuedAt: 1000, receivedAt: 5000, page: 1, multiPage: false });
        const done = submitted(shown, { accepted: true, sessionId: 'abc', duplicate: false });
        expect(done.status).toBe('done');
        // The thank-you is the form's own success message, in its theme, with nothing to answer.
        expect(done.ending).toMatchObject({ title: 'Thanks, all in.', description: '', fields: [], theme: { primary: '#0F766E' } });
    });
});

describe('a multi-page form', () => {
    const shown = started(INITIAL_FILL, { form: page('Intake', { multiPage: true }), csrf: 'c1', issuedAt: 1 }, 10);

    it('waits on its session after page one, and shows page two when the routine pauses for it', () => {
        const waiting = submitted(shown, { accepted: true, sessionId: 'sid1', duplicate: false });
        expect(waiting).toMatchObject({ status: 'working', sessionId: 'sid1', fileSessionId: 'sid1', form: null });
        const two = applySession(waiting, { state: 'form', stepId: 's2', form: page('Page two', { theme: null }), csrf: 'c2', issuedAt: 20 }, 30);
        expect(two).toMatchObject({ status: 'form', csrf: 'c2', page: 2, receivedAt: 30 });
        // A page without a theme of its own keeps the journey's.
        expect(two.theme).toEqual({ primary: '#0F766E' });
    });

    it('keeps the last trail while a tick has none, and takes a new one', () => {
        const waiting = submitted(shown, { accepted: true, sessionId: 'sid1', duplicate: false });
        const trail = applySession(waiting, { state: 'working', progress: ['Research', 'Search the web'], progressNote: 'Looks around' }, 1);
        expect(trail).toMatchObject({ progress: ['Research', 'Search the web'], progressNote: 'Looks around' });
        expect(applySession(trail, { state: 'working', progress: [], progressNote: null }, 2).progress).toEqual(['Research', 'Search the web']);
    });

    it('ends on the closing page, keeping the session files are fetched through', () => {
        const waiting = submitted(shown, { accepted: true, sessionId: 'sid1', duplicate: false });
        const done = applySession(waiting, { state: 'done', ending: page('All done') }, 1);
        expect(done).toMatchObject({ status: 'done', sessionId: null, fileSessionId: 'sid1' });
        expect(done.ending?.title).toBe('All done');
    });

    it('ends on the thank-you when the take came back without a session to follow', () => {
        expect(submitted(shown, { accepted: true, sessionId: null, duplicate: true }).status).toBe('done');
    });

    it('says so when the journey expired or failed', () => {
        const waiting = submitted(shown, { accepted: true, sessionId: 'sid1', duplicate: false });
        expect(applySession(waiting, { state: 'expired' }, 1).status).toBe('expired');
        expect(applySession(waiting, { state: 'error' }, 1)).toMatchObject({ status: 'error', sessionId: null });
    });

    it('stops waiting after the ceiling and checks again on request', () => {
        const waiting = submitted(shown, { accepted: true, sessionId: 'sid1', duplicate: false });
        expect(checkAgain(slowed(waiting)).status).toBe('working');
    });
});

it('picks a journey up by its session', () => {
    expect(resuming(INITIAL_FILL, 'sid9')).toMatchObject({ status: 'working', sessionId: 'sid9', multiPage: true });
});

it('tells a missing form from an unreachable server', () => {
    expect(failedToStart(INITIAL_FILL, 'missing').status).toBe('missing');
    expect(failedToStart(INITIAL_FILL, 'offline').status).toBe('offline');
});

describe('pacing', () => {
    it('eases the poll off to its ceiling', () => {
        let d = POLL_MIN_MS;
        for (let i = 0; i < 20; i += 1) d = nextPollDelay(d);
        expect(d).toBe(POLL_MAX_MS);
    });

    it('waits out the server’s two seconds before sending, and no longer', () => {
        expect(submitDelay(1000, 1500)).toBe(1500);
        expect(submitDelay(1000, 3500)).toBe(0);
    });

    it('mints nonces the server accepts', () => {
        for (let i = 0; i < 20; i += 1) expect(newNonce()).toMatch(/^[A-Za-z0-9_-]{8,80}$/);
        expect(newNonce(() => 0.5, () => 1)).not.toBe(newNonce(() => 0.25, () => 1));
    });
});
