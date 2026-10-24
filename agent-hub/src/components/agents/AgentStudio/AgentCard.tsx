import { Bot, Trash2 } from 'lucide-react';
import React from 'react';
import AgentCardFooter from './AgentCardFooter';
import { CATEGORY, EDIT, categoryOf, countsOf, editVerdict } from './agentCardFacts';
import type { AgentListRow, CategoryLike } from './agentCardFacts';
import { DEFAULT_AGENT_EMOJI, isImageAvatar, pickAgentAvatar, resolveAvatarSrc } from '../../../utils/agentAvatar';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import { kindTileStyle } from '../../shared/kindColors';
import StatusActionPill from '../../shared/StatusActionPill';
import { audienceLabel, audienceModeOf, makeGroupNamer } from '../../shared/VisibilityCapsule';
import { publishedVersionOf } from '../AgentWizard/builderSplit/AgentEditorHeader';
import type { TranslateFn } from '../../../hooks/useTranslation';
import type { OrgGroup } from '../AgentDesigner/PublishMenu';

export interface AgentCardProps<T extends AgentListRow> {
    t: TranslateFn;
    agent?: T | null;
    categories?: readonly CategoryLike[];
    orgGroups?: readonly OrgGroup[];
    viewerId?: string | null;
    onOpen: () => void;
    onDelete?: ((agent: T | null | undefined) => void) | null;
    selected?: boolean;
}

/**
 * One agent in the overview (Bee Flow Builder redesign, Sept 2026;
 * Agents artboard 1a, A5 part C).
 *
 * A card and not a text line, because four questions are put to this list and three
 * of them would have to be clicked open: what is he called, is he already running,
 * who may see him, and where does he actually talk from. The card answers them in
 * that order — name, status pill, meta line, three pills.
 *
 * ── TWO PUBLICATION VERBS ──────────────────────────────────────────
 * The status pill says LIVE/DRAFT on `published_version` (which config the runtime
 * serves). The meta line says with whom he is shared on `is_published` +
 * `shared_groups` (the audience). Those are two different questions that both
 * get called "publishing"; they stand next to each other for exactly that reason,
 * with their own words — `shared/VisibilityCapsule.audienceLabel` for the audience,
 * `StatusActionPill` for the status.
 *
 * ── ONE WARNING PER CARD, AND THAT COMES FROM THE SERVER ─────────────
 * There used to be a dotted `--error` row "No knowledge base", worked out from the
 * card's own knowledge count of zero. That was a second reading of a rule that lives
 * on the server (core/agentRuntime/agentGrounding.js), and it contradicted it: a
 * config that the server books as UNREADABLE — deliberately not an accusation — got a
 * red alarm here. On top of that it sat on the same card as the footer line that says
 * the same thing, so a new agent got two warnings for something that is still being
 * built.
 *
 * Now: the knowledge PILL shows the measured zero (a count, not a claim), and the
 * footer line (`AgentCardFooter`) makes the claim — solely on the word the server sent,
 * and only within the boundary that `cardFooter.ts` describes.
 *
 * ── THE TOOLS PILL IS A LOWER BOUND, AND SAYS SO ─────────────────────
 * An agent without `config.tools.automations` is NOT curated, and the runtime offers
 * it EVERY agent-callable automation of the asker plus every Step published in the
 * chat (core/integrations/integrationTools.js). "0 tools" was the opposite of the
 * truth there; `counts.toolsAtLeast` turns it into "at least n tools".
 *
 * ── ONE CARD, TWO BUTTONS, NO NESTED BUTTON ──────────────────────────
 * The card itself is one `<button>` (open). The bin is a SIBLING that lies absolutely
 * over it: a button inside a button is a keyboard trap and a riddle for the screen
 * reader.
 */
export default function AgentCard<T extends AgentListRow>({
    t,
    agent,
    categories = [],
    orgGroups = [],
    viewerId = null,
    onOpen,
    onDelete = null,
    selected = false,
}: AgentCardProps<T>) {
    const counts = countsOf(agent);
    const tf = filling(t);
    const verdict = editVerdict(agent);
    const cat = categoryOf(agent, categories);
    const version = publishedVersionOf(agent);
    const live = version > 0;
    const { tile, glyph } = kindTileStyle('agent', { size: 36, pct: 16 });
    // Only an EXPLICIT `can_edit: true` gives a bin — see EditBadge.
    const showDelete = !!onDelete && verdict === EDIT.YES;
    const avatar = pickAgentAvatar(agent) || DEFAULT_AGENT_EMOJI;

    // The audience in the words the capsule also uses in the editor.
    const mode = audienceModeOf({ isPublished: !!agent?.is_published, sharedGroups: agent?.shared_groups });
    const audience = audienceLabel(t, mode, agent?.shared_groups, makeGroupNamer({ orgGroups }));

    // The meta line, as a list — a missing part does not leave the separators behind
    // ("Sales ·  · organisation").
    const meta: string[] = [];
    if (cat.state === CATEGORY.NAMED) meta.push(cat.name);
    // A category we could not place is not "no category".
    else if (cat.state === CATEGORY.UNKNOWN) meta.push(t('agent_studio.card.category_unknown', 'Category unavailable'));
    if (live) meta.push(tx(t, 'agent_studio.card.version', 'v{version}', { version }));
    meta.push(audience);

    return (
        <li className="relative" data-testid="agent-card">
            <button
                type="button"
                onClick={onOpen}
                className="w-full h-full text-left flex flex-col gap-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                    padding: '14px 16px',
                    // Ruimte voor de prullenbak die er rechtsboven overheen ligt.
                    paddingRight: showDelete ? 44 : 16,
                    borderRadius: 12,
                    background: 'var(--bg-card)',
                    border: `1px solid ${selected ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                    boxShadow: 'var(--shadow-sm)',
                    outlineColor: 'var(--accent-primary)',
                }}
            >
                <span className="flex items-start gap-3 min-w-0">
                    <span style={tile} aria-hidden="true">
                        {isImageAvatar(avatar)
                            ? <img src={resolveAvatarSrc(avatar)} alt="" className="w-[100%] h-[100%] [object-fit:cover] [border-radius:inherit]" />
                            : avatar
                                ? <span className="[font-size:18px] [line-height:1]">{avatar}</span>
                                : <Bot style={glyph} />}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block font-semibold truncate text-[var(--text-primary)]">
                            {agent?.name || t('agent_studio.untitled', 'Untitled agent')}
                        </span>
                        <span className="block text-xs mt-0.5 truncate text-[var(--text-secondary)]">
                            {meta.join(' · ')}
                        </span>
                    </span>
                </span>

                <span className="flex items-center gap-2 flex-wrap">
                    <StatusActionPill
                        status={live ? 'live' : 'draft'}
                        action={null}
                        containerName={null}
                        testId="agent-card-status"
                        className="!h-6"
                    />
                    <EditBadge t={t} verdict={verdict} />
                </span>

                {counts.readable ? (
                    <span className="flex items-center gap-1.5 flex-wrap" data-testid="agent-card-counts">
                        <CountPill n={counts.knowledge} label={knowledgeLabel(tf, counts.knowledge)} />
                        <CountPill n={counts.skills} label={skillsLabel(tf, counts.skills)} />
                        {counts.tools === null ? (
                            // The `config.tools` section IS there but cannot be read.
                            // No number then, and no zero.
                            <CountPill n={null} label={t('agent_studio.card.tools_unreadable', 'Tools could not be read')} />
                        ) : (
                            <CountPill n={counts.tools} label={toolsLabel(tf, counts.tools, counts.toolsAtLeast)} />
                        )}
                    </span>
                ) : (
                    // Not three zeros: zero is a claim, and that has not been made here —
                    // the config could not be read.
                    <span className="text-xs text-[var(--text-tertiary)]" data-testid="agent-card-counts-unreadable">
                        {t('agent_studio.card.counts_unreadable', 'Configuration could not be read')}
                    </span>
                )}

                <AgentCardFooter agent={agent} viewerId={viewerId} />
            </button>

            {/* `can_edit !== false` was fail-open: `/agents/system` does not set the field,
                and such a row kept the button. Unknown narrows. */}
            {showDelete && (
                <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onDelete(agent); }}
                    className="absolute top-2 right-2 p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--bg-secondary)] transition"
                    title={t('agent_studio.delete', 'Delete')}
                    aria-label={`${t('agent_studio.delete', 'Delete')}: ${agent?.name || ''}`}
                >
                    <Trash2 size={14} />
                </button>
            )}
        </li>
    );
}

/**
 * t() with the placeholders ALWAYS filled in. The same reason and the same shape as
 * `tx` in shared/VisibilityCapsule.jsx and builderSplit/AgentEditorHeader.jsx:
 * the real translator interpolates by itself, a passed-in `t` (tests, embeds) does
 * not, and a pill that literally says "{count} tools" is worse than no pill.
 */
function tx(t: TranslateFn, key: string, fallback: string, params?: Record<string, unknown>) {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [k, v] of Object.entries(params || {})) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
}

/**
 * "1 knowledge base" / "3 knowledge bases" — singular and plural are two KEYS,
 * never a "(s)" after a word.
 *
 * THREE FUNCTIONS WITH LITERAL KEYS, not a `{key, one, many}` table. That table reached
 * `t()` as `pluralKey(spec.key, count)` — a variable — and that is precisely the class
 * "a key travels as data" that the i18n guard is blind to: from this file it reported
 * only `agent_studio.card.version`, so the six plural keys could stay English forever
 * without any test turning red. The neighbouring file AgentCardFooter.jsx calls `nOf`
 * with literals and is fully reported there.
 */
/**
 * `t` with the placeholders ALWAYS filled in, in the shape that `nOf` expects.
 *
 * It is made HERE and not at the call site: the i18n guard reads a helper call with
 * `\\b(nOf|tx|…)\\(([^()]*)\\)`, and that pattern breaks at the first bracket inside
 * the call. An `nOf(filling(t), …)` or an `nOf(t, 'key', Number(n) || 0, …)` would make
 * the whole call invisible — precisely the gap that the `{key, one, many}` table had too.
 */
function filling(t: TranslateFn) {
    return (key: string, fallback: string, params?: Record<string, unknown>) => tx(t, key, fallback, params);
}

function knowledgeLabel(tf: TranslateFn, n: number | null) {
    const count = Number(n) || 0;
    return nOf(tf, 'agent_studio.card.n_knowledge', count, '{count} knowledge base', '{count} knowledge bases');
}

function skillsLabel(tf: TranslateFn, n: number | null) {
    const count = Number(n) || 0;
    return nOf(tf, 'agent_studio.card.n_skills', count, '{count} skill', '{count} skills');
}

/**
 * The tools pill. `atLeast` means that the number is a LOWER BOUND: this agent has no automation curation, so the runtime lays every agent-callable automation of the asker on top of it, plus every published Step.
 */
function toolsLabel(tf: TranslateFn, n: number | null, atLeast: boolean) {
    const count = Number(n) || 0;
    return atLeast
        ? nOf(tf, 'agent_studio.card.n_tools_min', count, 'at least {count} tool', 'at least {count} tools')
        : nOf(tf, 'agent_studio.card.n_tools', count, '{count} tool', '{count} tools');
}

/** One count pill. Zero stays — that is a measured zero, not a missing one. */
function CountPill({ n, label }: { n: number | null; label: string }) {
    const empty = Number(n) === 0;
    return (
        <span
            className="inline-flex items-center text-[11px] whitespace-nowrap"
            style={{
                padding: '1px 7px',
                borderRadius: 999,
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border-default)',
                color: empty ? 'var(--text-tertiary)' : 'var(--text-secondary)',
            }}
        >
            {label}
        </span>
    );
}

/**
 * BFSF-271. `can_edit === false` as the only test was fail-open: `/agents/system` does not set the field, and such a row silently kept its edit affordances.
 * Unknown narrows AND says that it is unknown — a "View only" over a row whose answer we do not have would be a claim.
 */
function EditBadge({ t, verdict }: { t: TranslateFn; verdict: string }) {
    if (verdict === EDIT.YES) return null;
    const label = verdict === EDIT.NO
        ? t('agent_studio.view_only', 'View only')
        : t('agent_studio.edit_unknown', 'Edit rights unknown');
    return (
        <span
            data-testid={verdict === EDIT.NO ? 'agent-card-view-only' : 'agent-card-edit-unknown'}
            className="text-[9px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap [background:var(--bg-primary)] [border:1px_solid_var(--border-default)] [color:var(--text-tertiary)]!"
        >
            {label}
        </span>
    );
}
