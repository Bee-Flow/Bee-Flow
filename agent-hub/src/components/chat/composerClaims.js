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
import { TIER_META, configuredTierKeys } from '../licensing/tierMeta';

/** The tier key this composer will run on, or null when it cannot be known. */
function tierKeyFor({ directMode, modelTiers, selectedTier, selectedAgent }) {
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
        return TIER_META[key] ? key : null;
    }
    return null;
}

/**
 * What `auto` actually chose, read off the LAST answer — an older turn is
 * stale, and stale is a wrong claim rather than a missing one.
 */
function lastAutoTier(messages) {
    if (!Array.isArray(messages)) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (!msg || msg.role !== 'assistant') continue;
        const key = msg.autoSelectedTier || msg.modelTier;
        return typeof key === 'string' && key && key !== 'auto' ? key : null;
    }
    return null;
}

/**
 * @returns {{ tierKey: string, autoTierKey: string|null }|null}
 *   `autoTierKey` is non-null only for `auto`, and only after an answer.
 */
export function resolveTierClaim({
    directMode = false,
    modelTiers = null,
    selectedTier = null,
    selectedAgent = null,
    messages = null,
} = {}) {
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

/**
 * @param {object|null} data a parsed /api/privacy/shield-status body, or null
 *   when the status is unknown (offline, 401, unreadable).
 * @returns {{tone: string, key: string, en: string}|null} null = say nothing.
 */
export function shieldLine(data) {
    const { shieldActive, replacesPersonalData } = deriveShieldClaims(data);
    if (replacesPersonalData) return SHIELD_LINES.replaces;
    if (shieldActive) {
        // Active, but not a masking action: name what actually happens rather
        // than borrowing the word "replaced" from the case that does mask.
        if (data.action === 'block') return SHIELD_LINES.blocks;
        if (data.action === 'ask') return SHIELD_LINES.asks;
        return SHIELD_LINES.checks;
    }
    // Switched on, detector unreachable: the configuration is provable, the
    // protection is not. Say the configuration, and say the limit with it.
    if (data?.enabled === true) return SHIELD_LINES.unverified;
    return null;
}

/**
 * ── De voetregel (C11) ──────────────────────────────────────────────────
 *
 * Het artboard zet onder de composer: "Bee Flow draait op je eigen server.
 * Gesprekken verlaten je organisatie niet." Twee zinnen, en op élke installatie
 * is er minstens één van onwaar:
 *
 *   • Op beeflow.nl (Scaleway Kapsule) draait Bee Flow NIET op je eigen server.
 *   • Op self-host verlaat het gesprek de organisatie wél zodra de org een
 *     externe provider gebruikt — dan gaat de tekst naar buiten, alleen met
 *     plaatsvervangers in plaats van persoonsgegevens.
 *
 * De eerste zin is te bewijzen: `deploymentMode` komt uit /auth/setup-status
 * (server-env DEPLOYMENT_MODE) en zegt precies dit. De tweede is dat niet —
 * niets wat dit scherm kan opvragen zegt of het antwoordende model lokaal
 * draait. Er is dus geen conditie waaronder hij mag renderen, en hij staat
 * daarom nergens in deze module: een zin die je niet kunt onderbouwen hoort
 * niet achter een `if`, hij hoort niet te bestaan.
 *
 * Wat overblijft is één altijd-ware mededeling (het model kan zich vergissen)
 * plus, waar hij waar is, de plek waar dit draait. De privacyclaim zelf blijft
 * waar hij onderbouwd wordt: `shieldLine()` hierboven, in de toolbar, waar hij
 * ook een waarschuwende toon kan aannemen als de detector eruit ligt. Twee
 * keer dezelfde claim uit dezelfde bron, drie centimeter uit elkaar, levert
 * geen extra zekerheid op — alleen een tweede plek om te verlopen.
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
 * @param {object}  p
 * @param {string}  p.deploymentMode  'cloud' | 'self-hosted' (useDeploymentMode).
 * @param {boolean} p.signedIn        Is er een ingelogde gebruiker?
 * @returns {Array<{key: string, en: string}>} de zinnen, in leesvolgorde.
 *
 * `signedIn` doet er toe omdat "je eigen server" iemand ÍN de organisatie
 * aanspreekt. In een embed op de website van een klant leest dezelfde zin als
 * een uitspraak over de server van de bezoeker, en die is gewoon onwaar. Een
 * embed geeft bovendien zijn eigen `warningText` mee; die wint hoe dan ook, en
 * het call-site houdt dan de hele voetregel in de hand.
 */
export function footerNotice({ deploymentMode = 'cloud', signedIn = false } = {}) {
    const lines = [];
    if (signedIn && deploymentMode === 'self-hosted') lines.push(FOOTER_LINES.ownServer);
    lines.push(FOOTER_LINES.mistakes);
    return lines;
}
