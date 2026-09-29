/**
 * What the conversation HEADER is allowed to say about the chat below it (C1).
 *
 * The header is read at a glance and believed without checking — it sits above
 * the conversation the way a letterhead sits above a letter. That makes it the
 * worst place in the product for a claim that is merely probably true, and the
 * reason both statements it can make are derived here rather than in the JSX.
 *
 * ── The shield pill: RUNTIME, not CONFIGURATION ─────────────────────────
 * "A shield is switched on" and "this conversation is being shielded" are
 * different sentences about different things, and only the second is what a
 * green dot in a header means to the person reading it. The one rule already
 * lives in `deriveShieldClaims()` (hooks/useShieldStatus.js) and is imported
 * rather than restated: enabled AND the detector reachable — a shield that is
 * on while nothing can scan protects nobody, and a green dot over it is worse
 * than no dot, because it is the missing protection plus a reassurance.
 *
 * So this returns THREE outcomes, never two:
 *   'active'      — the runtime claim. Substantiated: on, and scanning.
 *   'unverified'  — the configuration claim, and ONLY that. Something true is
 *                   still worth saying, but it must not borrow the wording or
 *                   the colour of the claim it is not.
 *   null          — off, or unknown (offline, 401, junk body). Say nothing;
 *                   the absence of a statement is the statement.
 *
 * ── The knowledge-base pill ─────────────────────────────────────────────
 * Same subtraction the composer does (`resolveKbClaim`), for the same reason:
 * access is re-evaluated server-side on every read, so an id whose base was
 * deleted, unshared or taken out of chat still sits in the client's selection
 * long after the server stopped searching it. The header counts the
 * INTERSECTION with the list the server just handed us, and says nothing at
 * all while that list is unknown.
 *
 * Both helpers return STATE, never a sentence — no `{ key, en }` pairs travel
 * out of this module, so every string stays a literal t() call at the one
 * place that renders it and the i18n guard can see all of them.
 */

import { attachedNames, resolveKbClaim } from './knowledgeBaseClaim';
import { deriveShieldClaims } from '../../hooks/useShieldStatus';

/**
 * @param {object|null} data a parsed /api/privacy/shield-status body, or null
 *   when the status is unknown.
 * @returns {'active'|'unverified'|null}
 */
export function headerShieldState(data) {
    const { shieldActive } = deriveShieldClaims(data);
    if (shieldActive) return 'active';
    // Reachable-but-off is nothing: an organisation that turned the shield off
    // did not ask for a header reminding it of the fact on every screen.
    if (data && data.enabled === true) return 'unverified';
    return null;
}

/**
 * @param {object} args
 * @param {Array|null|undefined} args.availableKBs rows GET /api/kb returned.
 *   Anything that is not an array means UNKNOWN — not empty.
 * @param {Array|null|undefined} args.selectedKBIds ids this chat holds.
 * @returns {{count: number, names: string[], name: string|null}|null}
 *   null = render no pill. `name` is set only when a SINGLE base is attached
 *   and we have its name — the case the artboard draws, where naming it
 *   outright saves the reader from opening a picker to learn the one thing the
 *   pill exists to tell them. A single base whose name is missing falls back
 *   to the count rather than showing an id, which reads like a name to anyone
 *   who has not seen a uuid before.
 */
export function headerKbState({ availableKBs, selectedKBIds } = {}) {
    const claim = resolveKbClaim({ availableKBs, selectedKBIds });
    if (!claim || claim.attached.length === 0) return null;
    const names = attachedNames(claim);
    return {
        count: claim.attached.length,
        names,
        name: claim.attached.length === 1 && names.length === 1 ? names[0] : null,
    };
}
