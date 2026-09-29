/**
 * The two pieces of the feedback kit that decide something.
 *
 * ProgressBar and ErrorState are nested Views and need no test — but the
 * number the bar draws with, and the sentence the error state prints, are both
 * computed, and both are wrong in ways nobody sees.
 *
 * `progressPercent` came from features/recording, where it was computed inline
 * at the call site and clamped only on one side. Now that four screens can
 * reach it, the boundaries are worth writing down: the ones that matter are the
 * two ends and the floor, and all three are the kind of thing that is wrong by
 * one and never noticed.
 *
 * `describeError` is the only place on the phone that turns a refusal into
 * words. Its failure mode is not a crash but a confident wrong answer — a
 * status code answered with the wrong story sends a person to fix something
 * that was never broken.
 */

import { describeError, progressPercent } from './Feedback';
import { ApiError, OfflineError } from '../api/client';

describe('progressPercent', () => {
    it('reports whole per cent across the range', () => {
        expect(progressPercent(0.5)).toEqual({ percent: 50, width: '50%' });
        expect(progressPercent(0.637)).toEqual({ percent: 64, width: '64%' });
        expect(progressPercent(1)).toEqual({ percent: 100, width: '100%' });
    });

    it('holds a barely-started bar at a visible 2%, while still reporting the truth', () => {
        // The width and the announced value part company here on purpose. A
        // bar drawn 0.4% wide is indistinguishable from an empty one, and an
        // upload that has genuinely started must not look stalled — but
        // TalkBack should still say "zero per cent", not "two".
        expect(progressPercent(0)).toEqual({ percent: 0, width: '2%' });
        expect(progressPercent(0.004)).toEqual({ percent: 0, width: '2%' });
        expect(progressPercent(0.01)).toEqual({ percent: 1, width: '2%' });
        expect(progressPercent(0.02)).toEqual({ percent: 2, width: '2%' });
        expect(progressPercent(0.03)).toEqual({ percent: 3, width: '3%' });
    });

    it('clamps rather than trusts, at both ends', () => {
        // A byte counter that overshoots its own content-length is the usual
        // source of these, and `width: '104%'` on a bar inside an
        // overflow-hidden track is invisible right up until the day the track
        // stops hiding overflow.
        expect(progressPercent(1.04)).toEqual({ percent: 100, width: '100%' });
        expect(progressPercent(-0.5)).toEqual({ percent: 0, width: '2%' });
    });

    it('treats a NaN as no progress instead of rendering NaN%', () => {
        // Division by a zero total is how this arrives.
        expect(progressPercent(Number.NaN)).toEqual({ percent: 0, width: '2%' });
        expect(progressPercent(Number.POSITIVE_INFINITY)).toEqual({ percent: 0, width: '2%' });
    });
});

describe('describeError', () => {
    // Two branches here used to overwrite what the server said with a
    // category. The category is right; the sentence was not, and on a phone
    // the sentence is the only diagnosis anybody gets.

    it('keeps the server\'s own 404 sentence instead of "no longer exists"', () => {
        // A 404 is not always a deletion. Routes answer it for "not yours",
        // "wrong knowledge base", "no such document in this note" — and
        // telling someone the thing is gone sends them looking for a deletion
        // that never happened.
        expect(
            describeError(
                new ApiError('Skill not found or not owner', { status: 404, body: { error: 'Skill not found or not owner' } }),
            ),
        ).toEqual({ title: 'Not found', message: 'Skill not found or not owner', retryable: false });
    });

    it('falls back to the generic 404 line when the server wrote nothing usable', () => {
        // `HTTP 404` is the client's own placeholder for a body that was not
        // JSON (src/api/client.ts), not a sentence the server wrote. Showing
        // it would be a status code with extra steps.
        expect(describeError(new ApiError('HTTP 404', { status: 404 })).message).toBe(
            'This item no longer exists.',
        );
    });

    it('tells "not yours to edit" apart from "not on your plan" on a 403', () => {
        // S3 turned "visible but not editable" from a 404 into a 403 carrying
        // code `not_editable` (server/routes/skills.js). Without the branch, a
        // colleague who opens a shared skill and presses save is told to talk
        // to sales about a plan that would not have helped.
        const result = describeError(
            new ApiError('You cannot edit this skill', {
                status: 403,
                body: { error: 'You cannot edit this skill', code: 'not_editable' },
            }),
        );
        expect(result.title).toBe('Not yours to edit');
        expect(result.message).toBe('You cannot edit this skill');
        expect(result.retryable).toBe(false);
    });

    it('names being offline, and offers a retry for it', () => {
        // The client throws this for a transport failure while NetInfo says
        // there is no network (src/api/client.ts). It is the one error whose
        // remedy is in the person's hands, so it must never read as a fault.
        expect(describeError(new OfflineError())).toEqual({
            title: 'You are offline',
            message: 'Bee Flow will pick up where you left off once you are back on a network.',
            retryable: true,
        });
    });

    it('still reads a 403 with no code as an entitlement refusal', () => {
        // The other half of the branch: everything that is not `not_editable`
        // keeps the plan wording it has always had. This one also carries no
        // body at all, which is the shape that makes a careless
        // `(error.body as {code}).code` throw on the way here.
        expect(describeError(new ApiError('HTTP 403', { status: 403 }))).toEqual({
            title: 'Not available on your plan',
            message: 'Ask an administrator if you need access to this.',
            retryable: false,
        });
    });
});
