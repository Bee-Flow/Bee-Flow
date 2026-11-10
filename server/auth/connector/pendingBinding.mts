/**
 * Nextcloud connector: who the emailed one-time code of a pending binding is
 * for (auth/connectorBootstrap.js: verify, resend, retarget).
 *
 * The code goes to an administrator of the organisation it links, and to
 * nobody else. Anyone else connects with a pairing code from an organisation
 * administrator.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Account = { organizationId?: string | null; orgRole?: string | null; status?: string | null };
// Read at call time: tests replace the store's methods.
const userStore = nodeRequire('../../stores/userStore') as { getUserByEmail: (email: string) => Promise<Account | null> };
const { isOrgAdminRole } = nodeRequire('../permissions') as { isOrgAdminRole: (orgRole: unknown) => boolean };
const { isLoginBlockedAccount } = nodeRequire('../accountStatusGate') as { isLoginBlockedAccount: (user: unknown) => boolean };

/** True when `email` is the address of an administrator of the organisation `orgId`. */
export async function isAddressOfOrgAdmin(orgId: string, email: string | null | undefined): Promise<boolean> {
    const user = email ? await userStore.getUserByEmail(email) : null;
    return !!user && user.organizationId === orgId && isOrgAdminRole(user.orgRole) && !isLoginBlockedAccount(user);
}

/** What the setup screen shows for an address the code is not sent to. */
export function notOrgAdminAnswer(): { error: string; code: string } {
    return {
        error: 'The verification code is sent only to an administrator of the Bee Flow organisation this Nextcloud is being linked to. Open this page as a Nextcloud admin with the e-mail address of a Bee Flow organisation admin, or ask a Bee Flow organisation admin for a pairing code (Settings → Organisation → Pair a new Nextcloud) and enter it on the Bee Flow setup page.',
        code: 'email_not_in_org',
    };
}
