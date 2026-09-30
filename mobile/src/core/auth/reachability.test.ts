import { ApiError, OfflineError } from '@/core/api/client';

import { serverAnsweredAboutSession } from './reachability';

describe('telling "you are signed out" from "I could not ask"', () => {
    it('treats a 401 as the server answering about the session', () => {
        expect(serverAnsweredAboutSession(new ApiError('nope', { status: 401 }))).toBe(true);
    });

    it('treats a 403 the same way', () => {
        expect(serverAnsweredAboutSession(new ApiError('nope', { status: 403 }))).toBe(true);
    });

    it('does NOT sign the user out on a 500 — a deploy is not a logout', () => {
        expect(serverAnsweredAboutSession(new ApiError('boom', { status: 500 }))).toBe(false);
    });

    it('does NOT sign the user out on a 502 from a proxy mid-restart', () => {
        expect(serverAnsweredAboutSession(new ApiError('bad gateway', { status: 502 }))).toBe(false);
    });

    it('does NOT sign the user out when the device is offline', () => {
        expect(serverAnsweredAboutSession(new OfflineError())).toBe(false);
    });

    it('does NOT sign the user out on a timeout, which arrives with no status', () => {
        expect(serverAnsweredAboutSession(new ApiError('timed out'))).toBe(false);
    });

    it('does NOT sign the user out on a bare TypeError from the fetch layer', () => {
        expect(serverAnsweredAboutSession(new TypeError('Network request failed'))).toBe(false);
    });

    it('does not fall over on a thrown non-error', () => {
        expect(serverAnsweredAboutSession('nope')).toBe(false);
        expect(serverAnsweredAboutSession(null)).toBe(false);
        expect(serverAnsweredAboutSession(undefined)).toBe(false);
    });
});
