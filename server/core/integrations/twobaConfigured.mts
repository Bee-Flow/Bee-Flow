/**
 * Whether a user's 2BA connection is set up: the client id and secret, and a
 * sign-in (a user name and password, or "Sign in with 2BA"). Read through the
 * caller's `getSecret`, so the tool gate (integrationToolGroups.js), the agent
 * wizard and the settings status ask the same question in the same order. The
 * sign-in itself is integrations/twobaAuth.mts.
 */

export async function hasTwobaConfig(getSecret: (key: string) => Promise<unknown>, userId: string): Promise<boolean> {
    const has = async (field: string) => !!(await getSecret(`twoba_${field}_user_${userId}`));
    if (!(await has('client_id')) || !(await has('client_secret'))) return false;
    if ((await getSecret(`twoba_auth_mode_user_${userId}`)) === 'authorization_code') return true;
    return (await has('username')) && (await has('password'));
}

/** The settings status (GET /ai/user-settings): set up or not, the sign-in mode and the user name; never a secret. */
export async function twobaStatus(getSecret: (key: string) => Promise<unknown>, userId: string): Promise<{ hasTwobaConfig: boolean; twobaAuthMode: string; twobaUsername: string }> {
    return {
        hasTwobaConfig: await hasTwobaConfig(getSecret, userId),
        twobaAuthMode: (await getSecret(`twoba_auth_mode_user_${userId}`)) === 'authorization_code' ? 'authorization_code' : 'password',
        twobaUsername: String((await getSecret(`twoba_username_user_${userId}`)) || ''),
    };
}
