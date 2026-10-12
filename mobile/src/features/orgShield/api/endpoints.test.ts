/**
 * The "What happened" reads against a mocked client: what they ask the
 * server, and what they keep from the answer. The server refuses a health
 * category next to a person (400 special_category_per_person), so the phone
 * must never ask by person or by kind; and the rows carry a person, so they
 * keep no health label, whatever server answered.
 */

import { api } from '@/core/api/client';

import { getShieldActivity } from './endpoints';

jest.mock('@/core/api/client', () => {
    const actual = jest.requireActual('@/core/api/client');
    return { ...actual, api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn() } };
});

const get = api.get as jest.Mock;

/** An answer from a server from before health was stripped from the rows. */
const ANSWERS: Record<string, unknown> = {
    '/api/usage/guardrails/overview': {
        summary: { total_events: 3, pii_count: 3 },
        top_categories: [{ category: 'Email', count: 2 }, { category: 'MedicalCondition', count: 1 }],
        top_users: [{ user_id: 'u1', display_name: 'Bea', total: 3 }],
    },
    '/api/usage/integrations/overview': { summary: { total_calls: 2 } },
    '/api/usage/guardrails/recent': [
        { id: 1, timestamp: '2026-09-02T09:00:00Z', violation_type: 'pii', violation_categories: 'MedicalCondition,Email', display_name: 'Bea' },
        { id: 2, timestamp: '2026-09-02T10:00:00Z', violation_type: 'pii', violation_categories: 'Medication', display_name: 'Bea' },
    ],
    '/api/usage/integrations/egress': [
        { id: 3, timestamp: '2026-09-02T09:00:00Z', tool_name: 'gmail', dest_host: 'gmail.googleapis.com', pii_categories_detected: 'Person,HealthInsuranceNumber', display_name: 'Bea' },
        { id: 4, timestamp: '2026-09-02T11:00:00Z', tool_name: 'gmail', dest_host: 'gmail.googleapis.com', pii_categories_detected: 'Email', display_name: 'Cas' },
    ],
};

beforeEach(() => {
    get.mockReset();
    get.mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
});

describe('getShieldActivity', () => {
    it('asks for the window and the row cap only: never by person, never by kind', async () => {
        await getShieldActivity(30);
        expect(get).toHaveBeenCalledTimes(4);
        for (const [path, options] of get.mock.calls as [string, { query: Record<string, unknown> }][]) {
            expect([path, Object.keys(options.query).sort()]).toEqual([
                path,
                path.endsWith('/overview') ? ['days', 'interval'] : ['days', 'interval', 'limit'],
            ]);
        }
    });

    it('keeps the health total, and no health label on a row that carries a person', async () => {
        const activity = await getShieldActivity(30);
        expect(activity.guard.topCategories.map((c) => c.category)).toEqual(['Email', 'MedicalCondition']);
        // The row that named only health is left out, as the server does.
        expect(activity.events.map((e) => [e.id, e.categories])).toEqual([[1, 'Email']]);
        expect(activity.egress.map((r) => [r.id, r.piiCategories])).toEqual([[3, 'Person'], [4, 'Email']]);
    });
});
