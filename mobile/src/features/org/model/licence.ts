/** Reading the licence the way an administrator needs it. */

/** Inside thirty days is close enough that an admin should act now. */
export function expiringSoon(expiresAt: string, now = Date.now()): boolean {
    const at = new Date(expiresAt).getTime();
    if (Number.isNaN(at)) return false;
    return at - now < 30 * 24 * 60 * 60 * 1000;
}
