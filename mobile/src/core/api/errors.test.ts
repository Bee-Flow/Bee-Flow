/**
 * The only place on the phone that turns a refusal into words.
 *
 * Its failure mode is not a crash but a confident wrong answer — a status code
 * answered with the wrong story sends a person to fix something that was never
 * broken.
 */

import { ApiError, OfflineError } from './client';
import { describeError } from './errors';

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
        // JSON (src/core/api/client.ts), not a sentence the server wrote. Showing
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

    it('sends a training gate to a computer, where the course can be taken', () => {
        // server/learning/requireTraining.js answers every gated write with
        // this 403. Read as a plan refusal it would send the person to an
        // administrator about a licence, when what they need is a course the
        // phone has no screen for — and not "on the web" either, because the
        // web hides the Learning Center at phone width.
        const result = describeError(
            new ApiError('Finish the course "Agents 101" before using this.', {
                status: 403,
                body: {
                    error: 'training_required',
                    message: 'Finish the course "Agents 101" before using this.',
                    training: { area: 'agents', courseId: 'c1' },
                },
            }),
        );
        expect(result).toEqual({
            title: 'Training required',
            message:
                'Your organisation requires a short training before you can do this. Complete it in Bee Flow on a computer.',
            retryable: false,
        });
    });

    it('does not show a bare code as though it were the server\'s sentence', () => {
        // `{ error: 'not_found' }` with nothing else: the client keeps the code
        // as the message, but a person should get the 404 line, not the code.
        expect(
            describeError(new ApiError('not_found', { status: 404, body: { error: 'not_found' } })).message,
        ).toBe('This item no longer exists.');
    });

    it('names being offline, and offers a retry for it', () => {
        // The client throws this for a transport failure while NetInfo says
        // there is no network (src/core/api/client.ts). It is the one error whose
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
