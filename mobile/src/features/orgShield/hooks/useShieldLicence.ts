/**
 * The three licence features the editor offers or locks, as the web does:
 * `pii_tokenize` (the Replace action), `web_search_guard` (web-search
 * protection and holding data back from outside tools) and
 * `advanced_usage_monitoring` (the activity tab). A locked control is shown
 * disabled with the lock hint; while the entitlements have not answered
 * (`pending`) it is disabled without a hint, so nothing flashes "upgrade".
 */

import { lockHint, useGate, type GateResult, type LockReason } from '@/core/access';
import { useTranslation } from '@/core/i18n';

export interface Lock {
    open: boolean;
    hint: string | null;
}

function toLock(gate: GateResult, t: ReturnType<typeof useTranslation>): Lock {
    if (gate.visible && !gate.locked) return { open: true, hint: null };
    return { open: false, hint: gate.locked && gate.reason ? lockHint(gate.reason as LockReason, t) : null };
}

export function useShieldLicence() {
    const t = useTranslation();
    const tokenize = useGate({ license: 'pii_tokenize', lockOn: 'disable' });
    const webGuard = useGate({ license: 'web_search_guard', lockOn: 'disable' });
    const activity = useGate({ license: 'advanced_usage_monitoring', lockOn: 'disable' });
    return {
        tokenize: toLock(tokenize, t),
        webGuard: toLock(webGuard, t),
        activity: toLock(activity, t),
    };
}

export type ShieldLicence = ReturnType<typeof useShieldLicence>;
