/**
 * What this box is ALLOWED TO SAY about the next message.
 *
 * Four statements live here, and each one is computed the same way: from a
 * source that can substantiate it, or not at all. A pill that cannot be
 * substantiated is absent — an absent pill is a small loss and a lying one is
 * the whole product.
 *
 * The reasoning itself is not in this module; it is in composerClaims.js
 * (`resolveTierClaim`, `shieldLine`, `footerNotice`) and knowledgeBaseClaim.js
 * (`attachedNames`), so it can be tested without a composer around it. What
 * this hook owns is the WIRING: which inputs each claim is entitled to look at,
 * and the memoisation that keeps a claim from being recomputed on every
 * keystroke in the textarea.
 *
 * Hook order here mirrors the order these calls had inside InputArea, and it
 * is kept that way on purpose — they were lifted as one contiguous block.
 */
import { useMemo } from 'react';

import { useDeploymentMode } from '../../../hooks/useDeploymentMode';
import useShieldStatus from '../../../hooks/useShieldStatus';
import { tierLabel } from '../../licensing/tierMeta';
import { footerNotice, resolveTierClaim, shieldLine } from '../composerClaims';
import { attachedNames } from '../knowledgeBaseClaim';

export default function useComposerClaims({
    t,
    canShowPills,
    showTierSlider,
    directMode,
    modelTiers,
    selectedTier,
    selectedAgent,
    messages,
    kbClaim,
    user,
    shieldApplies,
}) {
    // C2 — the tier, by name, never the model (B4). ONLY where nothing else
    // already says it.
    //
    // Where the gauge beside Send is on screen it owns this choice outright:
    // it is the control, it carries the same four names, and a pill repeating
    // them a few pixels away is a second surface for one fact — one more thing
    // to read, and one more thing that can drift. So the pill stands down for
    // the gauge (`showTierSlider`) rather than sitting beside it.
    //
    // In AGENT chat there is no gauge — an agent runs on the tier it was saved
    // with — and there the pill is the only place the tier is legible at all.
    // That is the case it exists for, and it keeps it.
    const tierClaim = useMemo(() => (
        canShowPills && !showTierSlider
            ? resolveTierClaim({ directMode, modelTiers, selectedTier, selectedAgent, messages })
            : null
    ), [canShowPills, showTierSlider, directMode, modelTiers, selectedTier, selectedAgent, messages]);
    const tierPillLabel = tierClaim && (
        tierClaim.autoTierKey
            // Auto has no model before the turn and no depth of its own; once
            // an answer is back it can honestly report what the router picked.
            ? t('chat.composer.tier_auto_chose', 'Auto · {tier}', { tier: tierLabel(tierClaim.autoTierKey, modelTiers || {}) })
            : tierLabel(tierClaim.tierKey, modelTiers || {})
    );

    // C3 — the knowledge bases. One attached base is named outright, because
    // "Knowledge · 1" makes you open the picker to learn the one thing the
    // pill exists to tell you. Beyond one there is no room for names, so the
    // count carries it and the title spells them out. A base whose name is
    // missing falls back to the generic word instead of showing its id — an
    // id reads like a name to anyone who has not seen a uuid before.
    const kbNames = useMemo(() => attachedNames(kbClaim), [kbClaim]);
    const kbPillLabel = kbClaim && kbClaim.attached.length === 1 && kbNames.length === 1
        ? kbNames[0]
        : t('chat.composer.kb', 'Knowledge');
    const kbPillTitle = kbNames.length > 0
        ? t('chat.composer.kb_attached', 'Grounded on {names}', { names: kbNames.join(', ') })
        : t('chat.composer.kb_hint', 'What this chat is grounded on');

    // C5 — the privacy claim, from the one status route and the one rule in
    // deriveShieldClaims(). Disabled without a user: /api/privacy/shield-status
    // is authenticated, and an embed would otherwise poll a 401 every 30s.
    const { data: shieldStatus } = useShieldStatus({ enabled: !!user && shieldApplies });
    // Which of the two shield glyphs goes with the claim is decided where it
    // is drawn (ComposerActions.jsx) — a tone is a fact, an icon is a rendering.
    const shieldClaim = shieldApplies ? shieldLine(shieldStatus) : null;

    // C11 — de voetregel. De redenering staat in composerClaims.footerNotice():
    // van de twee artboardzinnen is er precies één te bewijzen, en de andere
    // ("Gesprekken verlaten je organisatie niet") staat er daarom niet — ook
    // niet achter een conditie. Dit is een SCHERMOVERSTIJGENDE regel: acht
    // call-sites delen deze box, waarvan één (EmbedChat) zijn eigen
    // `warningText` meegeeft. Die wint onverkort — een widget op de website van
    // een klant maakt geen uitspraken over wiens server dit is.
    const { mode: deploymentMode } = useDeploymentMode();
    const footerLine = useMemo(
        () => footerNotice({ deploymentMode, signedIn: !!user }).map(l => t(l.key, l.en)).join(' '),
        [deploymentMode, user, t],
    );

    return { tierClaim, tierPillLabel, kbPillLabel, kbPillTitle, shieldClaim, footerLine };
}
