/**
 * The cold-start tap contract: whatever launched the app is routed once —
 * exactly once — and always to a screen that exists.
 *
 * The bug this pins down: _layout.tsx only had the warm listener, so a tap
 * that COLD-started the app delivered its response before the listener
 * existed, and the user landed on the default tab wondering where their
 * approval went. Fixtures are the real payload background.ts schedules
 * (`{ notificationId, link }`) inside expo-notifications' response envelope.
 */

import { claimPushResponse, pushResponseKey, resetClaimedPushResponses } from './coldStart';
import { PUSH_FALLBACK_ROUTE } from './pushRoute';

/** The envelope expo-notifications hands back, with our payload inside. */
function response(id: string, link: string | null, date = 1_756_000_000_000) {
    return {
        actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
        notification: {
            date,
            request: {
                identifier: id,
                content: { data: { notificationId: id, link } },
            },
        },
    };
}

beforeEach(resetClaimedPushResponses);

describe('claimPushResponse', () => {
    it('routes a known web link to its native screen, once', () => {
        const tap = response('n1', '/app/cowork/abc123');
        expect(claimPushResponse(tap)).toBe('/cowork/abc123');
        // The effect re-runs when the auth stage flips, and Android can hand
        // the same response to the warm listener too. Second claim: no-op.
        expect(claimPushResponse(tap)).toBeNull();
    });

    it('routes distinct taps independently', () => {
        expect(claimPushResponse(response('n1', '/app/studio/approvals/apr-42'))).toBe(
            '/approvals/apr-42',
        );
        expect(claimPushResponse(response('n2', '/app/notebooks/nb-7'))).toBe('/notebooks/nb-7');
    });

    it('sends the summary notification to the inbox', () => {
        // background.ts sends { notificationId: null, link: null } for the
        // "3 more updates waiting" rollup — the inbox is its landing place.
        const summary = {
            notification: {
                date: 1,
                request: { identifier: 'sum-1', content: { data: { notificationId: null, link: null } } },
            },
        };
        expect(claimPushResponse(summary)).toBe(PUSH_FALLBACK_ROUTE);
    });

    it('answers null for no response at all', () => {
        // getLastNotificationResponseAsync resolves null on a normal launch;
        // null must mean "do not navigate", not "navigate to the fallback".
        expect(claimPushResponse(null)).toBeNull();
        expect(claimPushResponse(undefined)).toBeNull();
        expect(claimPushResponse('not-an-object')).toBeNull();
    });

    it('routes a garbled response to the inbox rather than crashing', () => {
        // Payload data crosses a process boundary; shape is not guaranteed.
        expect(claimPushResponse({})).toBe(PUSH_FALLBACK_ROUTE);
        expect(
            claimPushResponse({ notification: { date: 9, request: { content: {} } } }),
        ).toBe(PUSH_FALLBACK_ROUTE);
        expect(
            claimPushResponse({
                notification: { date: 2, request: { identifier: 'x', content: { data: 'garbage' } } },
            }),
        ).toBe(PUSH_FALLBACK_ROUTE);
        // Two responses too malformed to tell apart ARE the same as far as
        // this module can know — claimed once, so an auth-stage flip cannot
        // re-route the first one. Dropping a hypothetical second garbled tap
        // is the cheaper mistake.
        expect(claimPushResponse({})).toBeNull();
    });

    it('never answers something unnavigable', () => {
        const links = [
            '/app/studio/automations/a1?view=runs&run=r9',
            '/app/some/screen/added/next/year',
            'https://elsewhere.example/app/cowork/x',
            null,
        ];
        links.forEach((link, i) => {
            const route = claimPushResponse(response(`n${i}`, link));
            expect(typeof route).toBe('string');
            expect((route as string).startsWith('/')).toBe(true);
            expect((route as string).includes('not-found')).toBe(false);
        });
    });
});

describe('pushResponseKey', () => {
    it('keys on the request identifier when there is one', () => {
        expect(pushResponseKey(response('stable-id', '/app/x'))).toBe('stable-id');
    });

    it('still tells two malformed responses apart by date and link', () => {
        const a = { notification: { date: 1, request: { content: { data: { link: '/app/a' } } } } };
        const b = { notification: { date: 2, request: { content: { data: { link: '/app/b' } } } } };
        expect(pushResponseKey(a)).not.toBe(pushResponseKey(b));
        // …and both can be claimed, in order, exactly once each.
        expect(claimPushResponse(a)).not.toBeNull();
        expect(claimPushResponse(b)).not.toBeNull();
        expect(claimPushResponse(a)).toBeNull();
    });
});
