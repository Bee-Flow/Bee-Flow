import { describe, expect, it } from 'vitest';
import { createState, ROUTES } from '@/demo/fixtures/monitoring';
import type { AdoptionStudioItems } from './adoption.types';
import { itemsCsv } from './exportCsv';

type Handler = (ctx: { state: object; query: URLSearchParams }) => unknown;
const get = <T>(route: string, q = 'days=30') => (ROUTES as unknown as Record<string, Handler>)[`GET /api/usage/adoption/${route}`]({ state: createState(), query: new URLSearchParams(q) }) as T;

describe('itemsCsv', () => {
    it('lists the items with their makers and nothing else', () => {
        const csv = itemsCsv(get<AdoptionStudioItems>('studio/items', 'kind=agent'));
        const [head, first] = csv.split('\n');
        expect(head).toBe('name,owner,audience,created_at,last_used_at,people,uses,ai_cost');
        expect(first.startsWith('Sales assistant,Alex Morgan,org,')).toBe(true);
        expect(csv).not.toMatch(/Member · /);
    });
});
