/**
 * The colleagues of the Routines demo: who started a run, who decides an
 * approval, who a routine is shared with. One table, so a name reads the
 * same in the run list, the version history and the sharing dialog.
 *
 * Everyone here is invented. Addresses use example.com.
 */

export interface DemoPerson {
    id: string;
    name: string;
    email: string;
}

export interface DemoGroup {
    id: string;
    name: string;
    memberCount: number;
}

/** The visitor: the same id and name as DEMO_USER in common.js. */
export const ME: DemoPerson = { id: 'demo-user', name: 'Demo user', email: 'demo@example.com' };
export const SANNE: DemoPerson = { id: 'usr_demo_sdeboer', name: 'S. de Boer', email: 's.deboer@example.com' };
export const MARK: DemoPerson = { id: 'usr_demo_mjansen', name: 'M. Jansen', email: 'm.jansen@example.com' };
export const LOTTE: DemoPerson = { id: 'usr_demo_lbakker', name: 'L. Bakker', email: 'l.bakker@example.com' };
export const PIETER: DemoPerson = { id: 'usr_demo_pvisser', name: 'P. Visser', email: 'p.visser@example.com' };

export const FINANCE: DemoGroup = { id: 'grp_demo_finance', name: 'Finance', memberCount: 6 };
export const ACCOUNT_MANAGERS: DemoGroup = { id: 'grp_demo_accounts', name: 'Account managers', memberCount: 4 };

export const PEOPLE: DemoPerson[] = [ME, SANNE, MARK, LOTTE, PIETER];
export const GROUPS: DemoGroup[] = [FINANCE, ACCOUNT_MANAGERS];

/** `{ id, name }`, the shape run rows and version rows carry. */
export const ref = (p: DemoPerson) => ({ id: p.id, name: p.name });
