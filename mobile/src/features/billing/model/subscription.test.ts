import {
    canCancel,
    canChangePlan,
    canSubscribe,
    costPercent,
    currencySymbol,
    isPaidSubscription,
    isSettled,
    limitItems,
    money,
    onHighestPlan,
    planCaps,
    showUpgradeNudge,
    showUsageSharing,
} from './subscription';
import { plan, subscription } from './testing';

describe('the License & Usage rules', () => {
    it('writes money with the currency glyph, unknown codes as themselves', () => {
        expect(currencySymbol('eur')).toBe('€');
        expect(currencySymbol('GBP')).toBe('£');
        expect(currencySymbol(null)).toBe('€');
        expect(currencySymbol('CHF')).toBe('CHF');
        expect(money(4.5, 'usd')).toBe('$4.50');
    });

    it('takes AI usage as a whole, capped percentage of the cost cap, and nudges from 80 %', () => {
        expect(costPercent(subscription())).toBe(42);
        expect(costPercent(subscription({ usageCost: 250 }))).toBe(100);
        const uncapped = subscription({ limits: { ...subscription().limits, maxCostPerMonth: -1 } });
        expect(costPercent(uncapped)).toBe(0);
        expect(showUpgradeNudge(subscription({ usageCost: 79 }))).toBe(false);
        expect(showUpgradeNudge(subscription({ usageCost: 80 }))).toBe(true);
    });

    it('offers a plan change only on a settled Stripe subscription with somewhere to go', () => {
        expect(canChangePlan(subscription())).toBe(true);
        expect(canChangePlan(subscription({ cancelAtPeriodEnd: true }))).toBe(false);
        expect(canChangePlan(subscription({ pendingPlanId: 'basic' }))).toBe(false);
        expect(canChangePlan(subscription({ stripeSubscriptionId: null }))).toBe(false);
        expect(canChangePlan(subscription({ changeablePlans: [] }))).toBe(false);
    });

    it('says "highest plan" only for a paying subscription with nothing to change to', () => {
        expect(onHighestPlan(subscription({ changeablePlans: [] }))).toBe(true);
        expect(onHighestPlan(subscription())).toBe(false);
        const free = subscription({ changeablePlans: [], billing: { ...subscription().billing!, subscriptionTotal: 0 } });
        expect(onHighestPlan(free)).toBe(false);
    });

    it('sends a free or absent subscription to Checkout, and only when plans are on sale', () => {
        expect(canSubscribe(null, [plan()])).toBe(true);
        expect(canSubscribe(subscription({ stripeSubscriptionId: null }), [plan()])).toBe(true);
        expect(canSubscribe(subscription(), [plan()])).toBe(false);
        expect(canSubscribe(null, [])).toBe(false);
    });

    it('cancels only an active subscription that is not cancelling already', () => {
        expect(canCancel(subscription())).toBe(true);
        expect(canCancel(subscription({ status: 'trialing' }))).toBe(false);
        expect(canCancel(subscription({ cancelAtPeriodEnd: true }))).toBe(false);
    });

    it('titles a real subscription "Subscription & Usage" and settles on live Stripe ones', () => {
        expect(isPaidSubscription(null)).toBe(false);
        expect(isPaidSubscription(subscription({ stripeSubscriptionId: null }))).toBe(true);
        expect(isSettled(subscription({ status: 'trialing' }))).toBe(true);
        expect(isSettled(subscription({ stripeSubscriptionId: null }))).toBe(false);
        expect(isSettled(subscription({ status: 'incomplete' }))).toBe(false);
    });

    it('shows usage sharing whenever a cost budget is set, 0 included', () => {
        expect(showUsageSharing(subscription())).toBe(true);
        expect(showUsageSharing(subscription({ limits: { ...subscription().limits, maxCostPerMonth: 0 } }))).toBe(true);
        expect(showUsageSharing(subscription({ limits: { ...subscription().limits, maxCostPerMonth: null } }))).toBe(false);
        expect(showUsageSharing(null)).toBe(false);
    });

    it('lists only concrete caps, users as live seats against the cap', () => {
        expect(limitItems(subscription())).toEqual([{ key: 'users', value: '3 / 10' }]);
        const noSeats = subscription({ billing: null, limits: { ...subscription().limits, maxAgents: 5 } });
        expect(limitItems(noSeats)).toEqual([
            { key: 'users', value: '10' },
            { key: 'agents', value: '5' },
        ]);
        expect(planCaps(plan({ maxUsers: 5, maxAgents: -1, maxKnowledgeSources: 0 }))).toEqual({
            users: 5,
            agents: null,
            knowledge: null,
        });
    });
});
