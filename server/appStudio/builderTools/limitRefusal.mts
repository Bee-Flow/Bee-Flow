/**
 * The repair hint for a refused action whose errors are LIMITS (` — the maximum is N`): say which
 * limit and what the value is, and that nothing was cut, so the author shortens, merges or splits
 * instead of retrying blind.
 */

/**
 * @param {Array<{ code?: string, path?: string, message?: string }>} errors validator errors for one action
 * @param {string} actionId
 * @returns {string[]} one reason per limit error
 */
export function limitReasons(errors: Array<{ code?: string; path?: string; message?: string }>, actionId: string): string[] {
    const reasons: string[] = [];
    for (const e of errors) {
        const message = String(e.message || '');
        if (!/ the maximum is \d+/.test(message)) continue;
        const path = String(e.path || '').replace(`actions.${actionId}`, 'action');
        reasons.push(`${path}: ${message.replace(/\.$/, '')} — nothing was cut or dropped; shorten it, merge entries or split the action, then resend the whole action`);
    }
    return reasons;
}
