import type { AutomationUsageRow } from './types';
import { usageGuard } from './usageGuard';

const row = (over: Partial<AutomationUsageRow> = {}): AutomationUsageRow => ({
    automationId: 'a1', consumerKind: 'app', consumerId: 'app_1', consumerTitle: 'Expenses', refId: null, actionId: 'act',
    screenId: 'home', nodeId: 'n1', label: 'Submit', wired: true, updatedAt: null, canOpen: true, ...over,
});

describe('usageGuard', () => {
    it('lists each app button that starts the routine', () => {
        expect(usageGuard({ usage: [row(), row({ label: null, consumerTitle: null })], complete: true }, false)).toEqual({
            blocked: true,
            usage: [
                { kind: 'app', id: 'app_1', title: 'Expenses', siteLabel: 'Submit' },
                { kind: 'app', id: 'app_1', title: null, siteLabel: 'home' },
            ],
            unchecked: [],
            readable: true,
        });
    });

    it('never reads an incomplete index as "used nowhere"', () => {
        expect(usageGuard({ usage: [], complete: false }, false)).toMatchObject({ usage: [], unchecked: ['app'], readable: true });
    });

    it('treats a failed check as unreadable', () => {
        expect(usageGuard(null, true)).toEqual({ blocked: true, usage: [], unchecked: ['app'], readable: false });
        expect(usageGuard({ usage: [row()], complete: true }, true).readable).toBe(false);
    });
});
