/**
 * What the checks pane says about the settings, as data — so the flow card,
 * the cards below it and their tests agree on one reading.
 */

import type { ShieldEvidence } from '../../activity/useShieldEvidence';

/** A dictionary key and its English fallback. */
export interface Copy {
    key: string;
    fallback: string;
}

/**
 * Step ①: what happens to a message in which personal data is found.
 *
 * `unlicensed` is the stored-but-not-honoured case: the server does not clamp
 * a saved `tokenize` when the plan lacks placeholders, it stops the message
 * instead — so the flow must not draw "replace" as if it happened.
 */
export function actionStep(piiAction: string | undefined, canTokenize: boolean): Copy & { unlicensed: boolean } {
    if (piiAction === 'tokenize') {
        return {
            key: 'dlp.action_tokenize_label',
            fallback: 'Replace with placeholders',
            unlicensed: !canTokenize,
        };
    }
    return { key: 'dlp.action_block_label', fallback: 'Do not send the message', unlicensed: false };
}

const MODE_SHORT: Record<string, Copy> = {
    ask: { key: 'admin.shield_dlp_mode_ask_short', fallback: 'Ask' },
    auto_redact: { key: 'admin.shield_dlp_mode_redact_short', fallback: 'Hide it' },
    block: { key: 'admin.shield_dlp_mode_block_short', fallback: 'Do not send' },
};

/**
 * Step ②'s read-out: "off", or the mode it runs in. A mode this build does not
 * know reads as "on" rather than being guessed at.
 */
export function lastCheckReadout(dlpEnabled: boolean, dlpMode: string | undefined): Copy {
    if (!dlpEnabled) return { key: 'shield_checks.flow_off', fallback: 'off' };
    return MODE_SHORT[dlpMode || ''] || { key: 'shield_checks.flow_on', fallback: 'on' };
}

/**
 * How many tool calls carried personal data in the evidence window — or
 * null when that is not known.
 *
 * Unknown is not zero: without the figures (another mount, another plan) there
 * is nothing to say. And a zero means "none found" only when calls in the
 * window WERE checked. That is read from the ledger (`scannedCalls`), not from
 * the switch on this form: the switch may be unsaved, or was flipped after the
 * calls it would describe, and a zero from unchecked calls is a false
 * all-clear.
 */
export function toolGapCount(evidence: ShieldEvidence | null | undefined): number | null {
    if (!evidence || !Number.isFinite(evidence.toolPii)) return null;
    if (evidence.toolPii === 0 && evidence.scannedCalls === 0) return null;
    return evidence.toolPii;
}
