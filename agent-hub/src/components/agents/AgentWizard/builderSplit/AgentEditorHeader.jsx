import { FlaskConical, Link2, Rocket, UserRound, Wrench } from 'lucide-react';
import React from 'react';
import SaveStateIndicator from './SaveStateIndicator';
import { isImageAvatar, resolveAvatarSrc } from '../../../../utils/agentAvatar';
import StatusActionPill from '../../../shared/StatusActionPill';
import StudioSectionHeader, { OBJHEAD, PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import VisibilityCapsule from '../../../shared/VisibilityCapsule';

/**
 * AgentEditorHeader — de 48px kop van de agent-editor (Bee Flow Builder
 * herontwerp, sep 2026; Agents-artboard 1b, A2 stap 1).
 *
 * Dit bestand bouwt NIETS zelf: het is een compositie van de gedeelde
 * primitieven, zodat een agent met dezelfde rij opent als een kennisbank,
 * een tabel of een skill —
 *   shared/StudioSectionHeader   de rij zelf (terugpijl · tegel · naam ·
 *                                statuschip · tabs · capsule · primair)
 *   shared/VisibilityCapsule     "wie mag dit zien" (variant capsule,
 *                                anchored: een 48px balk klemt een absolute
 *                                popover af — BFSF-328)
 *   shared/StatusActionPill      LIVE / CONCEPT plus de ÉNE volgende stap
 *   builderSplit/SaveStateIndicator  de live opslagstatus
 *
 * ── AFWIJKING VAN HET ONTWERP, BEWUST ───────────────────────────────
 * Het artboard tekent een lucide-`bot` in de 28px tegel. Hier staat de
 * EMOJI of AFBEELDING van het avatar op die plek. Het avatar is de
 * identiteit van de agent in chat, in de agentenlijst, op de marketplace-
 * kaart en op mobiel; een bot-glyph in de editor zou de agent op precies
 * één scherm anders laten heten dan overal elders. De tegel zelf (kleur,
 * vorm, 18% tint van --type-ai) blijft die van kindColors — alleen de glyph
 * wijkt af. Een agent ZONDER avatar valt terug op de lucide-bot van
 * kindColors, dus de afwijking voegt niets toe waar niets is.
 *
 * ── TWEE PUBLICATIE-WERKWOORDEN, NIET DOOR ELKAAR ───────────────────
 * De capsule regelt het PUBLIEK (is_published + shared_groups, PATCH
 * /agents/:id/publish). De split-knop regelt de INHOUD: welke config en
 * welk systeemprompt de runtime serveert (published_version, POST
 * /agents/:id/publish-version). Ze staan naast elkaar in de kop omdat ze
 * allebei "publiceren" heten en het verschil alleen leesbaar is als je ze
 * naast elkaar ziet:
 *   published_version > 0  →  LIVE   · "Publish new version"
 *   published_version = 0  →  DRAFT  · "Publish"
 *
 * ── WAT DE KOP NIET DOET ────────────────────────────────────────────
 * Geen `inert` op deze rij. Alleen-lezen (BFSF-271) haalt de BEWERKENDE
 * affordances weg — hernoemen, publiceren, de capsule — maar terug,
 * tabs en de tellers blijven werken: iemand die een agent alleen mag
 * bekijken moet er wél doorheen kunnen lopen.
 */

/** De vier tabs van een agent, in artboard-volgorde. "Used by" is altijd laatst. */
export const AGENT_TAB_IDS = Object.freeze({
    ROLE: 'role',
    CAN_USE: 'can-use',
    TEST: 'test',
    USED_BY: 'used-by',
});

/**
 * Een teller die niet gelezen kon worden toont NIETS — nooit een 0.
 *
 * `0` is een BEWERING ("deze agent kan niets gebruiken", "niemand gebruikt
 * dit"), en die maken we alleen als we hem kunnen onderbouwen. Alles wat
 * geen eindig getal is — nog aan het laden, een mislukte fetch, een lijst
 * die we niet konden lezen — komt terug als `undefined`, en dan rendert de
 * badge van SegmentedControl niets (resolveSegmentedBadge).
 */
export function countOrNothing(value) {
    return Number.isFinite(value) ? value : undefined;
}

/**
 * De tabs met hun tellers. Puur, zodat de "geen 0"-regel hierboven te
 * testen is zonder een header te renderen.
 */
export function buildAgentTabs(t, { canUseCount, usedByCount } = {}) {
    return [
        { id: AGENT_TAB_IDS.ROLE, label: t('agent_studio.tab.role', 'Role'), icon: UserRound },
        { id: AGENT_TAB_IDS.CAN_USE, label: t('agent_studio.tab.can_use', 'Can use'), icon: Wrench, count: countOrNothing(canUseCount) },
        { id: AGENT_TAB_IDS.TEST, label: t('agent_studio.tab.test', 'Test'), icon: FlaskConical },
        { id: AGENT_TAB_IDS.USED_BY, label: t('agent_studio.tab.used_by', 'Used by'), icon: Link2, count: countOrNothing(usedByCount) },
    ];
}

/**
 * t() met de placeholders er ALTIJD ingevuld. De echte vertaler interpoleert
 * `{version}` zelf, maar een meegegeven `t` (tests, embeds) doet dat niet —
 * en een chip die letterlijk "Saved · v{version}" zegt is erger dan geen
 * chip. Zelfde reden en zelfde vorm als shared/VisibilityCapsule's `tx`.
 */
function tx(t, key, fallback, params) {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [k, v] of Object.entries(params || {})) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
}

/** `published_version` van een rij, als getal. Onleesbaar / afwezig ⇒ 0. */
export function publishedVersionOf(agent) {
    const raw = agent?.published_version ?? agent?.publishedVersion;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * De glyph in de kindtegel: het avatar van de agent (zie de afwijking in de
 * docblock), of `undefined` als er geen avatar is — dan valt
 * StudioSectionHeader terug op kindIcon('agent'), de lucide-bot.
 *
 * Let op waarom dit een FUNCTIE is en geen component die `null` teruggeeft:
 * `<AgentTileGlyph avatar={null} />` is zelf een geldig element, dus
 * `icon ?? kindIcon(kind)` in StudioSectionHeader zou het element kiezen en
 * een LEGE tegel tekenen. De terugval moet dus hier gebeuren, vóór de prop.
 */
export function agentTileIcon(avatar) {
    return avatar ? <AgentTileGlyph avatar={avatar} /> : undefined;
}

function AgentTileGlyph({ avatar }) {
    if (isImageAvatar(avatar)) {
        return (
            <img
                src={resolveAvatarSrc(avatar)}
                alt=""
                aria-hidden="true"
                data-testid="agent-tile-avatar"
                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }}
            />
        );
    }
    return (
        <span aria-hidden="true" data-testid="agent-tile-avatar" style={{ fontSize: 15, lineHeight: 1 }}>
            {avatar}
        </span>
    );
}

/**
 * Het statuschip-slot: "Saved · v8" uit `published_version`, met de LIVE
 * opslagstatus ernaast.
 *
 * De twee zeggen verschillende dingen en staan daarom naast elkaar: het chip
 * noemt de versie die het PUBLIEK draait, de indicator of het CONCEPT dat je
 * nu typt al op de server staat. Zonder gepubliceerde versie is er geen
 * versie om te noemen — dan blijft alleen de indicator over, want "v0" zou
 * een versie verzinnen die niet bestaat.
 */
function HeaderStatus({ t, publishedVersion, savingState, savedAt, saveErrorMsg, onRetrySave }) {
    return (
        <span className="flex items-center gap-2 flex-shrink-0">
            {publishedVersion > 0 && (
                <span
                    data-testid="agent-version-chip"
                    className="text-[11px] whitespace-nowrap"
                    style={{
                        color: 'var(--text-tertiary)',
                        padding: '3px 8px',
                        borderRadius: 999,
                        border: '1px solid var(--border-default)',
                    }}
                >
                    {tx(t, 'agent_studio.header.saved_version', 'Saved · v{version}', { version: publishedVersion })}
                </span>
            )}
            <SaveStateIndicator t={t} state={savingState} savedAt={savedAt} errorMsg={saveErrorMsg} onRetry={onRetrySave} />
        </span>
    );
}

/**
 * Het primaire slot. Drie gevallen, in deze volgorde:
 *   alleen-lezen        niets — er valt niets te publiceren
 *   concept zonder id   de expliciete eerste opslag (POST /agents)
 *   opgeslagen agent    de LIVE/CONCEPT-split-knop
 */
function PrimarySlot({ t, ro, agent, savingState, saveDraft, publishedVersion, onPublishVersion, publishing }) {
    if (ro) return null;
    if (!agent?.id) {
        return (
            <button
                type="button"
                onClick={saveDraft}
                disabled={savingState === 'saving'}
                data-testid="agent-save-draft"
                style={PRIMARY_ACTION_STYLE}
                className="h-8 px-3 rounded-[10px] text-[13px] font-semibold disabled:opacity-50 hover:brightness-95 transition"
            >
                {savingState === 'saving'
                    ? t('agent_wizard.builder.saving', 'Saving…')
                    : t('agent_wizard.builder.save_draft', 'Save')}
            </button>
        );
    }
    const live = publishedVersion > 0;
    return (
        <StatusActionPill
            status={live ? 'live' : 'draft'}
            containerName={OBJHEAD}
            testId="agent-publish-pill"
            action={{
                label: live
                    ? t('agent_studio.header.publish_new_version', 'Publish new version')
                    : t('agent_studio.header.publish', 'Publish'),
                icon: Rocket,
                onClick: onPublishVersion,
                disabled: !!publishing,
                // Publiceren is de voorwaartse stap, ook op een agent die al
                // live is — StatusActionPill zou hem daar anders stil maken.
                primary: true,
            }}
        />
    );
}

export default function AgentEditorHeader({
    t, ro = false, agent, name, avatar,
    onBack, onRename,
    tabs, activeTab, onTab,
    savingState, savedAt, saveErrorMsg, onRetrySave, saveDraft,
    publishedVersion = 0, onPublishVersion, publishing = false,
    capsuleOpen = false, onCapsuleToggle, onCapsuleClose,
    isPublished = false, sharedGroups = [], orgGroups = [], embedEnabled = false,
    onSetPersonal, onSetEntireOrg, onToggleGroup,
    extras = null,
}) {
    const capsule = agent?.id ? (
        <VisibilityCapsule
            t={t}
            agent={agent}
            variant="capsule"
            anchored
            confirmWidening
            disabled={ro}
            open={capsuleOpen}
            onToggle={onCapsuleToggle}
            onClose={onCapsuleClose}
            isPublished={isPublished}
            sharedGroups={sharedGroups}
            orgGroups={orgGroups}
            embedEnabled={embedEnabled}
            onSetPersonal={onSetPersonal}
            onSetEntireOrg={onSetEntireOrg}
            onToggleGroup={onToggleGroup}
        />
    ) : null;

    return (
        <StudioSectionHeader
            kind="agent"
            icon={agentTileIcon(avatar)}
            title={name}
            // Alleen-lezen: geen onRename, dus de naam is een <h1> en geen
            // knop die in een invoerveld verandert.
            onRename={ro ? undefined : onRename}
            statusChip={(
                <HeaderStatus
                    t={t}
                    publishedVersion={publishedVersion}
                    savingState={savingState}
                    savedAt={savedAt}
                    saveErrorMsg={saveErrorMsg}
                    onRetrySave={onRetrySave}
                />
            )}
            tabs={tabs}
            activeTab={activeTab}
            onTab={onTab}
            capsule={capsule}
            primary={(
                <PrimarySlot
                    t={t}
                    ro={ro}
                    agent={agent}
                    savingState={savingState}
                    saveDraft={saveDraft}
                    publishedVersion={publishedVersion}
                    onPublishVersion={onPublishVersion}
                    publishing={publishing}
                />
            )}
            extras={(
                <>
                    {ro && (
                        <span
                            role="status"
                            data-testid="agent-readonly-chip"
                            className="text-xs px-2.5 py-1.5 rounded-lg border border-amber-500/30 bg-amber-500/5 text-[var(--text-secondary)] whitespace-nowrap"
                        >
                            {t('agent_studio.read_only_banner', "Read-only — you don't have permission to edit this agent.")}
                        </span>
                    )}
                    {extras}
                </>
            )}
            onBack={onBack}
            backLabel={t('agent_studio.header.back_to_agents', 'Back to Agents')}
        />
    );
}
