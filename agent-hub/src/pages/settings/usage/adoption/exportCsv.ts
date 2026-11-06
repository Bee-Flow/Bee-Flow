/**
 * The items of one Studio kind as CSV, built on the client from what is on
 * screen: an explicit column list, never a dump of the row objects, so a field
 * the server adds next year does not leak into a file someone mails around.
 * The rows hold names of objects and their makers (organisational metadata),
 * no per-person usage.
 */
import { rowsToCsv } from '@/utils/usageHelpers';
import type { AdoptionStudioItems } from './adoption.types';

const num = (n: number | null | undefined) => (n == null ? '' : Number(n));

export function itemsCsv(d: AdoptionStudioItems): string {
    const rows = d.items.map(i => ({
        name: i.name, owner: i.ownerName, audience: i.audience, created_at: i.createdAt, last_used_at: i.lastUsedAt ?? '',
        people: num(i.people), uses: num(i.uses), ai_cost: num(i.cost),
    }));
    return rowsToCsv(['name', 'owner', 'audience', 'created_at', 'last_used_at', 'people', 'uses', 'ai_cost'], rows);
}
