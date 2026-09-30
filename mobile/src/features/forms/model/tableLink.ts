/**
 * A form's answers table, opened where the phone keeps tables: the table's own
 * screen (app/datatables/[id], features/datatables), on the tab asked for —
 * its rows, or how long they are kept. The web opens it in Studio →
 * Datatables; a Custom Tab on that page shares no session with the app and is
 * sent back to Chat on a phone, so the table is never opened in the browser.
 *
 * A route OBJECT, so its `pathname` is a literal src/meta/routes.test.ts holds
 * to a screen under app/. /datatables is not a tab root: push it.
 */

import type { Href } from 'expo-router';

import type { DatatableTab } from '@/features/datatables';

export function answersTablePath(datatableId: string, tab: Extract<DatatableTab, 'rows' | 'retention'> = 'rows'): Href {
    return { pathname: '/datatables/[id]', params: { id: datatableId, tab } };
}
