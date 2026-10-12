/**
 * What the checks panes say about the evidence, as data — so the cards and
 * their tests agree on one reading.
 */

import type { ShieldEvidence } from '../../activity/useShieldEvidence';

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
