/**
 * What the composer is ALLOWED to say about the message you are about to send.
 *
 * Two claims live here, both of which can lie if they are derived carelessly,
 * so both are derived once, in one place, and every branch that cannot be
 * substantiated returns `null` — the composer then shows nothing. A pill that
 * lies is worse than an absent pill: it is the absent pill plus a false
 * reassurance.
 *
 * ── The tier claim (C2, decision B4) ────────────────────────────────────
 * The composer names the TIER, never the model. Two reasons, both product
 * decisions rather than convenience: models are deliberately bound to tiers,
 * and on `auto` there is no model at all before the turn — the router picks
 * one while the answer streams. So `auto` says "Auto" up front and, once an
 * answer has come back, "Auto · <what it picked>" from the message itself.
 *
 * Where the tier comes from depends on the surface, and only two surfaces
 * actually know it:
 *   - a direct-mode composer with a tier map: whatever the picker has selected,
 *     but only if that key is really in the map (`configuredTierKeys`) — a
 *     selection the server never offered names a tier the user cannot have;
 *   - agent chat: the agent runs on the tier it was saved with, stored as the
 *     string `tier:<key>` on `agent.model`. A concrete model id there is NOT a
 *     tier and must stay unsaid (B4), and a `custom:` tier cannot be resolved
 *     without the map that carries its label.
 * Everything else — no map, a failed fetch ({}), an embed with no tier at
 * all — yields null.
 *
 * ── The shield claim (C5) ───────────────────────────────────────────────
 * THE rule already lives in `deriveShieldClaims()` (hooks/useShieldStatus.js)
 * and is imported rather than restated: a shield that is "on" while the
 * detector cannot scan is NOT active, and only a masking action may be worded
 * as "replaced". What this module adds is the distinction the composer needs
 * on top of it — a RUNTIME claim ("this message is shielded") versus a
 * CONFIGURATION ("shielding is switched on"). When only the second can be
 * shown, the second is what gets said, in a warning tone, without a green
 * lock. Unknown status says nothing at all.
 */

import { deriveShieldClaims } from '../../hooks/useShieldStatus';
import type { ShieldStatus } from '../../hooks/useShieldStatus';
import type { ChatMessage } from '../../hooks/useChatEngine/types';
import { TIER_META, configuredTierKeys } from '../licensing/tierMeta';

interface TierKeyArgs {
    directMode: boolean;
    modelTiers: Record<string, unknown> | null;
    selectedTier: string | null;
    selectedAgent: { model?: unknown } | null;
}

/** The tier key this composer will run on, or null when it cannot be known. */
function tierKeyFor({ directMode, modelTiers, selectedTier, selectedAgent }: TierKeyArgs): string | null {
    const hasMap = !!modelTiers && typeof modelTiers === 'object' && Object.keys(modelTiers).length > 0;
    if (directMode && hasMap) {
        const key = typeof selectedTier === 'string' ? selectedTier : '';
        return configuredTierKeys(modelTiers).includes(key) ? key : null;
    }
    const model = selectedAgent?.model;
    if (typeof model === 'string' && model.startsWith('tier:')) {
        const key = model.slice(5);
        // Only the built-in tiers carry a label without the server's map. A
        // custom tier would render as its raw id, which is a model-shaped
        // string in the composer — exactly what B4 forbids.
        return (TIER_META as Record<string, unknown>)[key] ? key : null;
    }
    return null;
}

/**
 * What `auto` actually chose, read off the LAST answer — an older turn is
 * stale, and stale is a wrong claim rather than a missing one.
 */
function lastAutoTier(messages: ChatMessage[] | null): string | null {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || msg.role !== 'assistant') continue;
        const key = msg.autoSelectedTier || msg.modelTier;
        return typeof key === 'string' && key && key !== 'auto' ? key : null;
    }
    return null;
}

export interface TierClaim {
    tierKey: string;
    autoTierKey: string | null;
}

/**
 * `autoTierKey` is non-null only for `auto`, and only after an answer.
 */
export function resolveTierClaim({
    directMode = false,
    modelTiers = null,
    selectedTier = null,
    selectedAgent = null,
    messages = null,
}: Partial<TierKeyArgs> & { messages?: ChatMessage[] | null } = {}): TierClaim | null {
    const tierKey = tierKeyFor({ directMode, modelTiers, selectedTier, selectedAgent });
    if (!tierKey) return null;
    return { tierKey, autoTierKey: tierKey === 'auto' ? lastAutoTier(messages) : null };
}

/**
 * The five things the composer may say about the shield, as `{ key, en }` so
 * the wording stays translatable and the choice stays testable.
 *
 * `tone: 'ok'` is a runtime claim and wears the green lock; `tone: 'warn'` is
 * configuration only — the shield is switched on, but nothing is being checked
 * right now, which the user is better off knowing than being reassured about.
 */
export const SHIELD_LINES = Object.freeze({
    replaces: Object.freeze({
        tone: 'ok', key: 'chat.composer.shield_replaces',
        en: 'Personal data is replaced before sending',
    }),
    blocks: Object.freeze({
        tone: 'ok', key: 'chat.composer.shield_blocks',
        en: 'Messages holding personal data are blocked',
    }),
    asks: Object.freeze({
        tone: 'ok', key: 'chat.composer.shield_asks',
        en: 'You are asked first when personal data is found',
    }),
    checks: Object.freeze({
        tone: 'ok', key: 'chat.composer.shield_checks',
        en: 'Personal data is checked before sending',
    }),
    unverified: Object.freeze({
        tone: 'warn', key: 'chat.composer.shield_unverified',
        en: 'Privacy Shield is on, but personal data cannot be checked right now',
    }),
});

export interface ShieldLine {
    tone: string;
    key: string;
    en: string;
}

/**
 * @param data a parsed /api/privacy/shield-status body, or null
 *   when the status is unknown (offline, 401, unreadable).
 * @returns null = say nothing.
 */
export function shieldLine(data: ShieldStatus | null | undefined): ShieldLine | null {
    const { shieldActive, replacesPersonalData } = deriveShieldClaims(data);
    if (replacesPersonalData) return SHIELD_LINES.replaces;
    if (shieldActive) {
        // Active, but not a masking action: name what actually happens rather
        // than borrowing the word "replaced" from the case that does mask.
        if ((data as ShieldStatus).action === 'block') return SHIELD_LINES.blocks;
        if ((data as ShieldStatus).action === 'ask') return SHIELD_LINES.asks;
        return SHIELD_LINES.checks;
    }
    // Switched on, detector unreachable: the configuration is provable, the
    // protection is not. Say the configuration, and say the limit with it.
    if (data?.enabled === true) return SHIELD_LINES.unverified;
    return null;
}

/**
 * ── The footer line (C11) ───────────────────────────────────────────────
 *
 * The artboard places this under the composer: "Bee Flow runs on your own server.
 * Conversations do not leave your organisation." Two sentences, and on every
 * installation at least one of them is untrue:
 *
 *   • On beeflow.nl (Scaleway Kapsule) Bee Flow does NOT run on your own server.
 *   • On self-host, the conversation DOES leave the organisation as soon as the org
 *     uses an external provider. Then the text goes outside, only with stand-ins
 *     in place of personal data.
 *
 * The first sentence is provable: `deploymentMode` comes from /auth/setup-status
 * (server env DEPLOYMENT_MODE) and says exactly this. The second is not. Nothing
 * this screen can query says whether the answering model runs locally. There is
 * therefore no condition under which it may render, and it is therefore nowhere in
 * this module. A sentence you cannot substantiate does not belong behind an `if`.
 * It should not exist.
 *
 * What remains is one always-true notice (the model can be mistaken) plus, where it
 * is true, the place where this runs. The privacy claim itself stays where it is
 * substantiated: `shieldLine()` above, in the toolbar, where it can also take on a
 * warning tone if the detector is off. Twice the same claim from the same source,
 * three centimetres apart, yields no extra certainty. It only gives a second place
 * to go stale.
 */
export const FOOTER_LINES = Object.freeze({
    ownServer: Object.freeze({
        key: 'chat.composer.footer_own_server',
        en: 'Bee Flow runs on your own server.',
    }),
    mistakes: Object.freeze({
        key: 'chat.composer.disclaimer',
        en: 'AI can make mistakes. Please verify important information.',
    }),
});

/**
 * @param p.deploymentMode  'cloud' | 'self-hosted' (useDeploymentMode).
 * @param p.signedIn        Is there a signed-in user?
 * @returns the sentences, in reading order.
 *
 * `signedIn` matters because "your own server" addresses someone INSIDE the
 * organisation. In an embed on a customer's website the same sentence reads as a
 * statement about the visitor's server, and that is simply untrue. An embed also
 * passes its own `warningText`, which wins in any case, and the call site then
 * holds the whole footer line in its hand.
 */
export function footerNotice({ deploymentMode = 'cloud', signedIn = false }: { deploymentMode?: string; signedIn?: boolean } = {}): Array<{ key: string; en: string }> {
    const lines: Array<{ key: string; en: string }> = [];
    if (signedIn && deploymentMode === 'self-hosted') lines.push(FOOTER_LINES.ownServer);
    lines.push(FOOTER_LINES.mistakes);
    return lines;
}
