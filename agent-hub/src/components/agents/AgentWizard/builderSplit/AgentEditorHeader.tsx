import { FlaskConical, Link2, Rocket, UserRound, Wrench } from 'lucide-react';
import React from 'react';
import SaveStateIndicator from './SaveStateIndicator';
import { isImageAvatar, resolveAvatarSrc } from '../../../../utils/agentAvatar';
import { managedOf } from '../../../shared/managedPart';
import ManagedPartBanner from '../../../shared/ManagedPartBanner';
import StatusActionPill from '../../../shared/StatusActionPill';
import StudioSectionHeader, { OBJHEAD, PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import VisibilityCapsule from '../../../shared/VisibilityCapsule';
import type { TranslateFn, TranslateParams } from '../../../../hooks/useTranslation';
import type { StudioSectionHeaderTab } from '../../../projects/workspace/studioParts';
import type { AudienceEntity, OrgGroup } from '../../../shared/VisibilityCapsule.types';

/**
 * AgentEditorHeader — the 48px header of the agent editor (Bee Flow Builder redesign, Sept 2026;
 * Agents artboard 1b, A2 step 1).
 *
 * This file builds NOTHING itself: it is a composition of the shared primitives, so that an agent
 * opens with the same row as a knowledge base, a table or a skill —
 *   shared/StudioSectionHeader   the row itself (back arrow · tile · name · status chip · tabs · capsule · primary)
 *   shared/VisibilityCapsule     "who may see this" (variant capsule, anchored: a 48px bar clamps an
 *                                absolute popover — BFSF-328)
 *   shared/StatusActionPill      LIVE / DRAFT plus the ONE next step
 *   builderSplit/SaveStateIndicator  the live save status
 *
 * ── DEVIATION FROM THE DESIGN, DELIBERATE ───────────────────────────
 * The artboard draws a lucide `bot` in the 28px tile. Here the EMOJI or IMAGE of the avatar stands in
 * that place. The avatar is the identity of the agent in chat, in the agent list, on the marketplace
 * card and on mobile; a bot glyph in the editor would make the agent be called something different on
 * exactly one screen than everywhere else. The tile itself (colour, shape, 18% tint of --type-ai) stays
 * that of kindColors — only the glyph deviates. An agent WITHOUT an avatar falls back on the lucide-bot
 * of kindColors, so the deviation adds nothing where there is nothing.
 *
 * ── TWO PUBLISH VERBS, NOT CONFUSED ─────────────────────────────────
 * The capsule governs the AUDIENCE (is_published + shared_groups, PATCH /agents/:id/publish). The split
 * button governs the CONTENT: which config and which system prompt the runtime serves (published_version,
 * POST /agents/:id/publish-version). They stand next to each other in the header because both are called
 * "publish" and the difference is only legible when you see them side by side:
 *   published_version > 0  →  LIVE   · "Publish new version"
 *   published_version = 0  →  DRAFT  · "Publish"
 *
 * ── AN AGENT A SOLUTION STAGE MANAGES ──────────────────────────────
 * `managed` (from the agent GET, or the prop) makes the agent read-only for
 * whoever edits it: no rename and no "Publish" (a deploy owns the version),
 * with the banner under the row. The AUDIENCE stays settable: sharing and
 * `embed_enabled` are on the stage's allow-list, so the capsule keeps working.
 * The AI builder chat lives in BuilderSplit and goes away there.
 *
 * ── WHAT THE HEADER DOES NOT DO ─────────────────────────────────────
 * No `inert` on this row. Read-only (BFSF-271) removes the EDITING affordances — rename, publish, the
 * capsule — but back, tabs and the counters keep working: someone who may only view an agent must still
 * be able to walk through it.
 */

/** De vier tabs van een agent, in artboard-volgorde. "Used by" is altijd laatst. */
export const AGENT_TAB_IDS = Object.freeze({
    ROLE: 'role',
    CAN_USE: 'can-use',
    TEST: 'test',
    USED_BY: 'used-by',
});

/**
 * A counter that could not be read shows NOTHING — never a 0.
 *
 * `0` is a CLAIM ("this agent cannot use anything", "nobody uses this"), and we only make it when we can
 * back it up. Everything that is not a finite number — still loading, a failed fetch, a list that we could
 * not read — comes back as `undefined`, and then the badge of SegmentedControl renders nothing
 * (resolveSegmentedBadge).
 */
export function countOrNothing(value: number | null | undefined) {
    return Number.isFinite(value) ? value : undefined;
}

/**
 * The tabs with their counters. Pure, so that the "no 0" rule above can be tested without rendering a header.
 */
export function buildAgentTabs(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, { canUseCount, usedByCount }: { canUseCount?: number | null; usedByCount?: number | null } = {}) {
    return [
        { id: AGENT_TAB_IDS.ROLE, label: t('agent_studio.tab.role', 'Role'), icon: UserRound },
        { id: AGENT_TAB_IDS.CAN_USE, label: t('agent_studio.tab.can_use', 'Can use'), icon: Wrench, count: countOrNothing(canUseCount) },
        { id: AGENT_TAB_IDS.TEST, label: t('agent_studio.tab.test', 'Test'), icon: FlaskConical },
        { id: AGENT_TAB_IDS.USED_BY, label: t('agent_studio.tab.used_by', 'Used by'), icon: Link2, count: countOrNothing(usedByCount) },
    ];
}

/**
 * t() with the placeholders ALWAYS filled in. The real translator interpolates `{version}` itself, but a
 * passed-in `t` (tests, embeds) does not — and a chip that literally says "Saved · v{version}" is worse than
 * no chip. Same reason and same shape as shared/VisibilityCapsule's `tx`.
 */
function tx(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, key: string, fallback: string, params: { version: number }) {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [k, v] of Object.entries(params || {})) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
}

/** `published_version` van een rij, als getal. Onleesbaar / afwezig ⇒ 0. */
export function publishedVersionOf(agent: { published_version?: unknown; publishedVersion?: unknown } | { [key: string]: unknown } | null | undefined) {
    const raw = agent?.published_version ?? agent?.publishedVersion;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The glyph in the kind tile: the agent's avatar (see the deviation in the
 * docblock), or `undefined` if there is no avatar. Then StudioSectionHeader
 * falls back to kindIcon('agent'), the lucide-bot.
 *
 * Note why this is a FUNCTION and not a component that returns `null`:
 * `<AgentTileGlyph avatar={null} />` is itself a valid element, so
 * `icon ?? kindIcon(kind)` in StudioSectionHeader would pick the element and
 * draw an EMPTY tile. The fallback therefore has to happen here, before the prop.
 */
function agentTileIcon(avatar: string | null) {
    return avatar ? <AgentTileGlyph avatar={avatar} /> : undefined;
}

interface AgentTileGlyphProps {
    avatar: string | null;
}

function AgentTileGlyph({ avatar }: AgentTileGlyphProps) {
    if (isImageAvatar(avatar)) {
        return (
            <img
                src={resolveAvatarSrc(avatar)}
                alt=""
                aria-hidden="true"
                data-testid="agent-tile-avatar"
                className="w-[100%] h-[100%] [object-fit:cover] [border-radius:inherit]"
            />
        );
    }
    return (
        <span aria-hidden="true" data-testid="agent-tile-avatar" className="[font-size:15px] [line-height:1]">
            {avatar}
        </span>
    );
}

/**
 * The status-chip slot: "Saved · v8" from `published_version`, with the LIVE
 * save status next to it.
 *
 * The two say different things and therefore sit side by side: the chip names
 * the version that the PUBLIC is running, the indicator says whether the DRAFT
 * you are typing right now is already on the server. Without a published version
 * there is no version to name, so only the indicator remains, because "v0" would
 * invent a version that does not exist.
 */
interface HeaderStatusProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    publishedVersion: number;
    savingState: string | null;
    savedAt: Date | null;
    saveErrorMsg: string;
    onRetrySave: () => void;
}

function HeaderStatus({ t, publishedVersion, savingState, savedAt, saveErrorMsg, onRetrySave }: HeaderStatusProps) {
    return (
        <span className="flex items-center gap-2 flex-shrink-0">
            {publishedVersion > 0 && (
                <span
                    data-testid="agent-version-chip"
                    className="text-[11px] whitespace-nowrap [color:var(--text-tertiary)]! [padding:3px_8px] [border-radius:999px] [border:1px_solid_var(--border-default)]"
                >
                    {tx(t, 'agent_studio.header.saved_version', 'Saved · v{version}', { version: publishedVersion })}
                </span>
            )}
            <SaveStateIndicator t={t} state={savingState} savedAt={savedAt} errorMsg={saveErrorMsg} onRetry={onRetrySave} />
        </span>
    );
}

/**
 * The primary slot. Three cases, in this order:
 *   read-only           nothing: there is nothing to publish
 *   managed (`locked`)  nothing: a Solution deploy owns the version
 *   draft without id    the explicit first save (POST /agents)
 *   saved agent         the LIVE/DRAFT split button
 */
/** The agent row as the header reads it: its id may be null for an unsaved draft. */
type HeaderAgent = Omit<AudienceEntity, 'id'> & { id?: string | null };

interface PrimarySlotProps {
    t: TranslateFn;
    agent?: HeaderAgent | null;
    ro: boolean;
    locked?: boolean;
    savingState: string | null;
    saveDraft: React.MouseEventHandler<HTMLButtonElement>;
    publishedVersion: number;
    onPublishVersion: () => void;
    publishing: boolean;
}

function PrimarySlot({ t, ro, locked = false, agent, savingState, saveDraft, publishedVersion, onPublishVersion, publishing }: PrimarySlotProps) {
    if (ro || locked) return null;
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
                // Publishing is the forward step, also on an agent that is already
                // live. StatusActionPill would otherwise make it inert there.
                primary: true,
            }}
        />
    );
}

export default function AgentEditorHeader(props: AgentEditorHeaderProps) {
    const managed = props.managed ?? managedOf(props.agent);
    return (
        <>
            <AgentHeaderRow {...props} onRename={managed ? undefined : props.onRename} managed={!!managed} />
            {managed ? <ManagedPartBanner managed={managed} /> : null}
        </>
    );
}

interface AgentEditorHeaderProps extends Omit<AgentHeaderRowProps, 'managed'> {
    managed?: ReturnType<typeof managedOf>;
}

interface AgentHeaderRowProps {
    t: TranslateFn;
    ro?: boolean;
    managed: boolean;
    agent?: HeaderAgent | null;
    name: string;
    avatar: string | null;
    onBack: React.MouseEventHandler<HTMLButtonElement>;
    onRename?: (next: string) => void;
    tabs?: StudioSectionHeaderTab[];
    activeTab?: string;
    onTab?: (id: string) => void;
    savingState: string | null;
    savedAt: Date | null;
    saveErrorMsg: string;
    onRetrySave: () => void;
    saveDraft: React.MouseEventHandler<HTMLButtonElement>;
    onPublishVersion: () => void;
    extras?: React.ReactNode;
    publishedVersion?: number;
    publishing?: boolean;
    capsuleOpen?: boolean;
    onCapsuleToggle?: () => void;
    onCapsuleClose?: (() => void) | null;
    isPublished?: boolean;
    sharedGroups?: string[] | null;
    orgGroups?: readonly OrgGroup[];
    embedEnabled?: boolean;
    onSetPersonal?: () => void;
    onSetEntireOrg?: () => void;
    onToggleGroup?: (groupId: string) => void;
}

function AgentHeaderRow({
    t, ro = false, managed, agent, name, avatar,
    onBack, onRename,
    tabs, activeTab, onTab,
    savingState, savedAt, saveErrorMsg, onRetrySave, saveDraft,
    publishedVersion = 0, onPublishVersion, publishing = false,
    capsuleOpen = false, onCapsuleToggle, onCapsuleClose,
    isPublished = false, sharedGroups = [], orgGroups = [], embedEnabled = false,
    onSetPersonal, onSetEntireOrg, onToggleGroup,
    extras = null,
}: AgentHeaderRowProps) {
    const capsule = agent?.id ? (
        <VisibilityCapsule
            t={t}
            agent={agent as AudienceEntity}
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
            // Read-only: no onRename, so the name is an <h1> and not a
            // button that turns into an input field.
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
                    locked={managed}
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
