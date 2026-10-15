// Shapes shared by the agent editor's hero and category field.
import type { READ } from './canUse/canUseFacts';

/** Whether a source could be read: not yet, read, or unreadable. */
export type ReadState = (typeof READ)[keyof typeof READ];

/** An agent category as `GET /agents/categories` lists it. */
export type CategoryRow = { id: string; name: string; icon?: string };

/** What the category actions answer with. */
export interface CategoryResult {
    ok: boolean;
    existed?: boolean;
    error?: string;
    code?: string;
    count?: number;
}
