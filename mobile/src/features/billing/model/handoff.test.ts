import { returnOrigin, settleCheckout, SETTLE_DEADLINE_MS, type SettleDeps } from './handoff';
import { subscription } from './testing';

describe('returnOrigin', () => {
    it('is the bare origin the checkout route accepts', () => {
        expect(returnOrigin('https://beeflow.nl')).toBe('https://beeflow.nl');
        expect(returnOrigin('https://app.example.com:8443/beeflow')).toBe('https://app.example.com:8443');
        expect(returnOrigin(null)).toBeUndefined();
        expect(returnOrigin('not a url')).toBeUndefined();
    });
});

describe('settleCheckout', () => {
    function deps(over: Partial<SettleDeps> & { clock?: { t: number } } = {}): SettleDeps {
        const clock = over.clock ?? { t: 0 };
        return {
            session: jest.fn(async () => ({ status: 'complete', subscriptionStatus: 'active' })),
            subscription: jest.fn(async () => subscription()),
            wait: jest.fn(async (ms: number) => {
                clock.t += ms;
            }),
            now: () => clock.t,
            ...over,
        };
    }

    it('reads a session that is still open as a checkout the customer left', async () => {
        const d = deps({ session: jest.fn(async () => ({ status: 'open', subscriptionStatus: null })) });
        await expect(settleCheckout(d)).resolves.toBe('cancelled');
        expect(d.subscription).not.toHaveBeenCalled();
    });

    it('polls the subscription until Stripe manages it and it is live', async () => {
        const answers = [subscription({ stripeSubscriptionId: null }), subscription({ status: 'incomplete' }), subscription()];
        const d = deps({ subscription: jest.fn(async () => answers.shift() ?? null) });
        await expect(settleCheckout(d)).resolves.toBe('activated');
        expect(d.wait).toHaveBeenCalledTimes(2);
        // The first read, then one reconcile per round.
        expect(d.session).toHaveBeenCalledTimes(3);
    });

    it('gives up after the web’s thirty seconds, and a failed read is just another round', async () => {
        const d = deps({ subscription: jest.fn(async () => Promise.reject(new Error('offline'))) });
        await expect(settleCheckout(d)).resolves.toBe('slow');
        expect((d.wait as jest.Mock).mock.calls.length).toBe(SETTLE_DEADLINE_MS / 1500);
    });

    it('stops when the screen went away', async () => {
        const d = deps({ subscription: jest.fn(async () => null), cancelled: () => true });
        await expect(settleCheckout(d)).resolves.toBe('slow');
        expect(d.subscription).not.toHaveBeenCalled();
    });
});
