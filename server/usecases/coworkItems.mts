/**
 * Who may touch a Cowork item: its owner, and nobody else (routes/cowork.js and routes/coworkReviewRoutes.js). The
 * same rule for viewing, editing, running and handling a review: a missing item is 404, another person's is 403, with
 * the code the Cowork routes have always answered (`cowork_refused`).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

const { HttpError } = nodeRequire('../core/http/errors') as { HttpError: new (status: number, code: string, message: string) => Error };
// Without an extension: the route tests swap the store under exactly this request string.
const coworkStore = nodeRequire('../stores/coworkStore') as typeof import('../stores/coworkStore.js');

export type CoworkItem = NonNullable<Awaited<ReturnType<typeof coworkStore.getSchedule>>>;

/** The item, when `userId` owns it. */
export async function loadOwnedItem(id: string, userId: string): Promise<CoworkItem> {
    const existing = await coworkStore.getSchedule(id);
    if (!existing) throw new HttpError(404, 'cowork_refused', 'Not found');
    if (existing.userId !== userId) throw new HttpError(403, 'cowork_refused', 'Forbidden');
    return existing;
}
