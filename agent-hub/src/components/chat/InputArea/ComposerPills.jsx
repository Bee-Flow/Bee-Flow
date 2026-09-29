/**
 * The "+" menu and the pills, as ONE group — the whole left-hand side of the
 * composer's toolbar row.
 *
 * They travel together for two reasons. In Cowork mode this whole value is
 * handed to the shared CoworkComposer through its `chatTools` slot, where it
 * is HIDDEN rather than unmounted so every popover keeps its state across a
 * switch back to Chat — one wrapper, one `hidden`, nothing left behind. And in
 * chat the toolbar row is `justify-between` with exactly two children: a third
 * would be pushed to the middle of the composer, which is where the apps
 * picker once ended up floating. Everything on the left is in here; only the
 * send cluster sits opposite.
 *
 * Hidden by the `hidden` ATTRIBUTE as well as the utility class, and never by
 * a conflicting `flex`/`hidden` pair on one element: the attribute takes the
 * group out of the accessibility tree too, so a screen reader is not offered
 * chat tools that a sighted user cannot see, and it holds up without a
 * stylesheet.
 *
 * Each pill renders only where it can be substantiated — the wording and the
 * conditions are in composerClaims.js and useComposerClaims.js; what is here
 * is where each one sits and which picker it owns.
 *
 * Who may be told at all is decided by the composer (`canShowPills`), next to
 * the reason — an anonymous visitor on a customer's website is not shown this
 * organisation's configuration.
 */
import React from 'react';

import useTranslation from '../../../hooks/useTranslation';
import AppsPicker from '../../apps/AppsPicker';
import SkillsPopover from '../../skills/SkillsPopover';
import ComposerPill from '../ComposerPill';
import ComposerToolsMenu from '../ComposerToolsMenu';

import MediaCreationPanel from './MediaCreationPanel';

const ComposerPills = ({
    // The "+" menu and the pickers it hands off to
    composerTools,
    canCreateMedia,
    mediaMenuOpen,
    setMediaMenuOpen,
    showImageGen,
    showMusicGen,
    showElevenLabs,
    showVideoGen,
    canPickApps,
    availableApps,
    isAppEnabled,
    toggleApp,
    appsOpen,
    setAppsOpen,
    onPickApp,
    // The group as a whole
    inCoworkMode,
    compact,
    canShowPills,
    // C2 — the tier
    tierClaim,
    tierPillLabel,
    directMode,
    // C4 — Skills
    canPickSkills,
    activeSkillCount,
    skillsOpen,
    setSkillsOpen,
    user,
    activeSkillIds,
    agentAttachedSkillIds,
    directConversationId,
    directSessionSkills,
    directActivatedSessionSkillIds,
    onToggleSkill,
    // C3 — knowledge bases
    canPickKBs,
    kbStatementOnly,
    kbClaim,
    kbPillLabel,
    kbPillTitle,
    showKBPicker,
    setShowKBPicker,
    kbPickerRef,
    kbPickerPanel,
    // NB-8 — a notebook's source count
    sourceCount,
}) => {
    const { t } = useTranslation();

    // The chat-only tools: one "+" menu, plus the panels its rows hand off to.
    // Hoisted to a value because BOTH composers render it: chat inline, and the
    // shared CoworkComposer through its `chatTools` slot, where it is hidden
    // rather than unmounted so the popovers keep their state across a switch
    // back to Chat.
    //
    // The pickers below render no trigger of their own — they are anchored in
    // the menu's flyout slot, so hovering their row reveals each one beside the
    // menu instead of replacing it.
    const chatToolsMenu = (
        <ComposerToolsMenu items={composerTools}>
            {/* Multimedia Creation — panel only; the row that opens it is in the menu */}
            <MediaCreationPanel
                enabled={canCreateMedia}
                open={mediaMenuOpen}
                onOpenChange={setMediaMenuOpen}
                showImageGen={showImageGen}
                showMusicGen={showMusicGen}
                showElevenLabs={showElevenLabs}
                showVideoGen={showVideoGen}
            />
            {/* Knowledge bases are not here either — the picker moved out
                with its pill (C3), so it opens under the thing that was
                clicked instead of beside the "+". */}
            {/* Skills is not here — its panel moved out with its pill, so
                the popover opens under the thing you clicked. Voice mode
                stays a row: it needs no panel, it swaps the whole composer
                for <VoiceInlinePanel>. */}
            {/* Apps — in chat it is a row like the others. In
                Cowork it keeps a button of its own, below, where
                the schedule chips are: a brief runs unattended
                against the user's integrations, which makes
                "which apps may it touch" a decision with
                consequences after you have closed the tab. */}
            {canPickApps && !inCoworkMode && (
                <AppsPicker
                    apps={availableApps}
                    isAppEnabled={isAppEnabled}
                    toggleApp={toggleApp}
                    open={appsOpen}
                    onOpenChange={setAppsOpen}
                    hideTrigger
                    placement="up"
                    onPick={onPickApp}
                />
            )}
        </ComposerToolsMenu>
    );

    return (
        <div
            hidden={inCoworkMode}
            className={inCoworkMode ? 'hidden' : 'flex items-center gap-1.5 flex-wrap min-w-0'}
        >
            {chatToolsMenu}

            {/* C2 — the tier, by name, and only where the gauge is not. In
                agent chat there is no picker at all, so this is the only place
                the tier is legible; wherever the gauge IS on screen it owns
                the choice and the pill stands down (see `tierClaim`). */}
            {tierClaim && (
                <ComposerPill
                    kind="agent"
                    label={tierPillLabel}
                    testId="composer-pill-tier"
                    compact={compact}
                    title={directMode
                        ? t('chat.composer.tier_hint', 'The depth the next answer runs at')
                        : t('chat.composer.tier_hint_agent', 'The depth this agent runs at')}
                />
            )}

            {/* C4 — Skills. The pill owns `skillsOpen` outright (its row is
                gone from the menu) and its popover is anchored here, so the
                panel opens under the thing that was clicked. */}
            {canShowPills && canPickSkills && (
                <span className="relative inline-flex items-center">
                    <ComposerPill
                        kind="skill"
                        label={t('chat.composer.skills', 'Skills')}
                        count={activeSkillCount}
                        open={skillsOpen}
                        onClick={() => setSkillsOpen(v => !v)}
                        testId="composer-pill-skills"
                        compact={compact}
                        title={t('chat.composer.skills_hint', 'Reusable instruction packs for this chat')}
                    />
                    <SkillsPopover
                        user={user}
                        activeSkillIds={activeSkillIds}
                        attachedSkillIds={agentAttachedSkillIds}
                        directMode={!!directMode}
                        directConversationId={directConversationId}
                        directSessionSkills={directSessionSkills}
                        directActivatedSessionSkillIds={directActivatedSessionSkillIds}
                        onToggleSkill={onToggleSkill}
                        open={skillsOpen}
                        onOpenChange={setSkillsOpen}
                        hideTrigger
                    />
                </span>
            )}

            {/* C3 — the knowledge bases behind the next answer. The pill owns
                `showKBPicker` outright (its row is gone from the menu) and the
                picker is anchored here, under the thing that was clicked.

                It appears only where `kbClaim` could be resolved, so a list
                that never loaded shows no pill rather than an empty one: "no
                knowledge bases" and "we could not ask" look identical to a
                reader and mean opposite things about where the answer came
                from. The wrapper carries the outside-click ref so a click on
                the pill itself is inside the picker and does not close it in
                the same gesture that opens it.

                KNOWN GAP, worth naming here rather than in a ticket: a chat
                inside a PROJECT is also grounded on that project's knowledge
                bases, which are a second, independently authorised source
                (routes/ai/directChat/promptAssembly.js) and never land in
                `direct_conversations.knowledge_base_ids`. This pill counts
                only the conversation's own, so in a project it UNDER-reports.
                Under-reporting is the safer half of the trade — it never
                claims a source that was not used — but it is still not the
                whole answer, and the composer is not handed the project today.
                Whoever wires the project through should widen the claim rather
                than fold the two lists together: the picker may only detach
                what the conversation owns. */}
            {canShowPills && (canPickKBs || kbStatementOnly) && (
                <span className="relative inline-flex items-center" ref={kbPickerRef}>
                    <ComposerPill
                        kind="kb"
                        label={kbPillLabel}
                        count={kbClaim.attached.length > 1 ? kbClaim.attached.length : null}
                        open={canPickKBs && showKBPicker}
                        onClick={canPickKBs ? () => setShowKBPicker(v => !v) : null}
                        testId="composer-pill-kb"
                        compact={compact}
                        title={kbPillTitle}
                    />
                    {canPickKBs && kbPickerPanel}
                </span>
            )}

            {/* NB-8 — how many sources this chat can reach. Only a notebook
                passes a number; `null` means the surface has no such thing,
                which is not the same as none and shows nothing. */}
            {typeof sourceCount === 'number' && (
                <ComposerPill
                    kind="kb"
                    label={sourceCount === 1
                        ? t('chat.composer.n_sources', '1 source')
                        : t('chat.composer.n_sources_plural', '{count} sources', { count: sourceCount })}
                    testId="composer-pill-sources"
                    compact={compact}
                    title={t('chat.composer.sources_hint', 'What this chat can look things up in')}
                />
            )}
        </div>
    );
};

export default ComposerPills;
