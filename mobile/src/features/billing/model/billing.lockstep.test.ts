/**
 * Pinned to the web and the server: the Customer Portal predicate runs beside
 * agent-hub's own (differential), its status list matches the server's gate
 * (textual), and the currency glyphs match orgInfoShared.jsx.
 */

import fs from 'node:fs';
import path from 'node:path';

import { AGENT_HUB_SRC, loadWebModule } from '@/shared/testing/webModule';

import { currencySymbol, hasPaidBillingRelationship, PORTAL_ELIGIBLE_PAYMENT_STATUSES } from './subscription';

const web = loadWebModule<{
    hasPaidBillingRelationship: (sub: unknown) => boolean;
    PORTAL_ELIGIBLE_PAYMENT_STATUSES: string[];
}>('utils/billing.js');

describe('billing lockstep', () => {
    it('asks the web’s question about the Customer Portal', () => {
        const cases = [
            null,
            { stripe_customer_id: null, payment_status: 'paid' },
            ...['paid', 'past_due', 'paused', 'disputed', 'failed', 'refunded', 'trialing', 'unpaid', null].map((status) => ({
                stripe_customer_id: 'cus_1',
                payment_status: status,
            })),
        ];
        for (const sub of cases) {
            const mine = sub ? { stripeCustomerId: sub.stripe_customer_id, paymentStatus: sub.payment_status } : null;
            expect({ sub, eligible: hasPaidBillingRelationship(mine) }).toEqual({ sub, eligible: web.hasPaidBillingRelationship(sub) });
        }
        expect([...PORTAL_ELIGIBLE_PAYMENT_STATUSES]).toEqual(web.PORTAL_ELIGIBLE_PAYMENT_STATUSES);
    });

    it('keeps the server’s portal gate in the same list', () => {
        const portal = fs.readFileSync(path.resolve(__dirname, '../../../../../server/routes/stripe/portal.js'), 'utf8');
        const list = PORTAL_ELIGIBLE_PAYMENT_STATUSES.map((s) => `'${s}'`).join(', ');
        expect(portal).toContain(`const PORTAL_ELIGIBLE_PAYMENT_STATUSES = [${list}];`);
    });

    it('writes currencies with orgInfoShared.jsx’s glyphs', () => {
        const shared = fs.readFileSync(`${AGENT_HUB_SRC}/components/admin/org/orgInfo/orgInfoShared.jsx`, 'utf8');
        expect(shared).toContain("{ EUR: '€', USD: '$', GBP: '£' }[String(c || 'EUR').toUpperCase()] || (c || '€')");
        expect([currencySymbol('EUR'), currencySymbol('USD'), currencySymbol('GBP')]).toEqual(['€', '$', '£']);
    });
});
