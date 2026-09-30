/**
 * What the composer may say about the Privacy Shield — the port of the web's
 * shieldLine (components/chat/composerClaims.js) and deriveShieldClaims
 * (hooks/useShieldStatus.ts), pinned by shieldLine.lockstep.test.ts.
 *
 * The rule: a runtime claim ("personal data is replaced") only while the
 * detector is reachable; a shield that is on with its detector down says so
 * in the warning tone; unknown says nothing.
 */

import type { ShieldStatus } from '../api/composerStatus';

export interface ShieldWords {
    tone: 'ok' | 'warn';
    i18nKey: string;
    en: string;
}

export const SHIELD_LINES = {
    replaces: { tone: 'ok', i18nKey: 'chat.composer.shield_replaces', en: 'Personal data is replaced before sending' },
    blocks: { tone: 'ok', i18nKey: 'chat.composer.shield_blocks', en: 'Messages holding personal data are blocked' },
    asks: { tone: 'ok', i18nKey: 'chat.composer.shield_asks', en: 'You are asked first when personal data is found' },
    checks: { tone: 'ok', i18nKey: 'chat.composer.shield_checks', en: 'Personal data is checked before sending' },
    unverified: {
        tone: 'warn',
        i18nKey: 'chat.composer.shield_unverified',
        en: 'Privacy Shield is on, but personal data cannot be checked right now',
    },
} as const satisfies Record<string, ShieldWords>;

export function deriveShieldClaims(data: ShieldStatus | null | undefined): { shieldActive: boolean; replacesPersonalData: boolean } {
    if (!data) return { shieldActive: false, replacesPersonalData: false };
    const shieldActive = data.enabled === true && data.guardReachable === true;
    return { shieldActive, replacesPersonalData: shieldActive && data.action === 'redact' };
}

export function shieldLine(data: ShieldStatus | null | undefined): ShieldWords | null {
    const { shieldActive, replacesPersonalData } = deriveShieldClaims(data);
    if (replacesPersonalData) return SHIELD_LINES.replaces;
    if (shieldActive) {
        if (data?.action === 'block') return SHIELD_LINES.blocks;
        if (data?.action === 'ask') return SHIELD_LINES.asks;
        return SHIELD_LINES.checks;
    }
    if (data?.enabled === true) return SHIELD_LINES.unverified;
    return null;
}
