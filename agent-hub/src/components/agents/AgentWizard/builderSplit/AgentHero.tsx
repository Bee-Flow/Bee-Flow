import { FolderOpen, Gauge, Languages, Pencil } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { CategoryResult, CategoryRow, ReadState } from '../agentEditor.types';
import type { ModelTierMap } from '../../../../api/queries/modelTiers';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { TIER_META, customTierMeta } from '../../../licensing/tierMeta';
import CategoryField from '../CategoryField';
import { READ } from '../canUse/canUseFacts';
import AvatarPicker from '../pickers/AvatarPicker';
import { logger } from '../../../../utils/logger';

/**
 * AgentHero: the identity ROW of the agent editor, directly under the shared
 * heading and ABOVE the cards of the Role tab (Bee Flow Builder redesign, Sep
 * 2026; Agents artboard 1b/1c, A2 step 1 + A3 part B).
 *
 * What is shown, always visible:
 *   56px tile    the avatar (AvatarPicker, size="hero") with a pencil badge,
 *                so that "you can click here" is not something you have to guess
 *   name         the same input field as before
 *   category     `CategoryField variant="tag"`: the same component the old
 *                Role tab used, in chip format next to the chips
 *   description  NOT behind an "Add description" button. An agent without a
 *                description is an agent that nobody knows the purpose of, and the
 *                place to fix that must not itself be hidden. Empty shows a placeholder.
 *   chips        the tier (gauge + TIER_META label) and the language from
 *                `persona.language`
 *
 * The chips are READERS, not controls: you change the tier with the
 * ModelTierSelector in the Role tab, and the language with the persona. They
 * are here because, together with name and description, they answer "who is
 * this", and because an agent that quietly answers in French would otherwise
 * only be noticed when a customer reports it. The category tag IS a control: it
 * is here because it belongs to the identity ("Sales ▾"), and it stood on the
 * Role tab in the way of the five role cards.
 *
 * A chip we cannot substantiate is not shown: no tier in the list means no tier
 * chip, and no nameable language code means no language chip. See `languageChipLabel`.
 *
 * THE COUNTER UNDER THE DESCRIPTION SAYS WHERE THE TEXT ENDS UP, and that has been
 * checked: `AgentMarketplace`'s card draws `description` under the agent's name
 * (components/agents/AgentMarketplace.jsx, AgentCard), and that list is what people
 * open to choose an agent. The list contains the own agents AND the published ones
 * (AgentHub/useAgentHubData.refreshAgents), so the sentence also holds before
 * publication. On Android it holds too: `mobile/.../AgentRow.tsx` sets
 * `agent.description` as the subtitle of every row. Should that ever stop being
 * true, this sentence must go. An explanation that is not true is worse than no
 * explanation.
 */

/**
 * The i18n key per built-in tier. TIER_META carries English constants (it is
 * also the source for the dropdown and the chat badge); here they get their
 * translation. One LITERAL t() call per tier, because a key that is composed
 * from a variable cannot be checked by the i18n guard, and a tier chip that
 * shows "tier.fast" is worse than an English "Fast".
 */
function tierLabelOf(t: TranslateFn, key: string, tiers?: ModelTierMap | null) {
    switch (key) {
        case 'auto': return t('tier.auto', TIER_META.auto.label);
        case 'fast': return t('tier.fast', TIER_META.fast.label);
        case 'standard': return t('tier.standard', TIER_META.standard.label);
        case 'swarm': return t('tier.swarm', TIER_META.swarm.label);
        case 'thinking': return t('tier.thinking', TIER_META.thinking.label);
        case 'writer': return t('tier.writer', TIER_META.writer.label);
        // `pro` is an ALIAS of deep_thinking in TIER_META — same icon, same
        // emoji, same label — so it shares the key rather than getting one of
        // its own. I18N-CONVENTIES §1.3 forbids a second key with the same
        // text, and two keys would also let a translator move them apart, so
        // the same tier would answer in two different words.
        case 'deep_thinking':
        case 'pro':
            return t('tier.deep_thinking', TIER_META.deep_thinking.label);
        default:
            // A custom tier carries the name the administrator typed themselves.
            // That is user data, not product copy, so it does not go through t().
            return key && key.startsWith('custom:') ? customTierMeta(key, tiers?.[key]).label : null;
    }
}

/**
 * The name of a language code, or null.
 *
 * Mirrors `server/core/agentRuntime/personaPrompt.js:languageNameOf`: what we
 * cannot name, we do not name. The server only stores codes it could name, so in
 * practice refusing costs nothing. A chip with a raw code in it ("xx-YZ") is not
 * a language but a leak from the database. `Intl.DisplayNames` does not exist in
 * every environment, so everything sits in a try/catch: no name, no chip.
 */
export function languageChipLabel(code: unknown, locale = 'en') {
    if (typeof code !== 'string' || !code.trim()) return null;
    const base = code.trim().toLowerCase().split('-')[0];
    if (!/^[a-z]{2,3}$/.test(base)) return null;
    try {
        const name = new Intl.DisplayNames([locale || 'en'], { type: 'language' }).of(base);
        if (typeof name === 'string' && name && name.toLowerCase() !== base) return name;
    } catch (err) { logger.debug('geen ICU ⇒ geen naam ⇒ geen chip', err); }
    return null;
}

/** De chipvorm van de hero: 24px hoog, hairline, tertiaire glyph. */
function HeroChip({ Icon, children, title, testId }: { Icon: LucideIcon; children?: ReactNode; title?: string; testId?: string }) {
    return (
        <span
            data-testid={testId}
            title={title}
            className="inline-flex items-center gap-1.5 h-6 px-2 rounded-lg text-[12px] whitespace-nowrap border border-[var(--border-default)] bg-[var(--bg-card,transparent)] text-[var(--text-secondary)]"
        >
            <Icon size={12} aria-hidden="true" className="text-[var(--text-tertiary)]" />
            <span>{children}</span>
        </span>
    );
}

export interface AgentHeroProps {
    t: TranslateFn;
    ro?: boolean;
    avatar: string;
    updateAvatar: (avatar: string) => void;
    name: string;
    updateName: (name: string) => void;
    flushNow: () => void;
    description: string;
    updateDescription: (description: string) => void;
    tiers?: ModelTierMap | null;
    selectedTier: string;
    language?: string | null;
    locale?: string;
    categoryId?: string | null;
    categories?: CategoryRow[] | null;
    categoriesState?: ReadState;
    updateCategory?: (id: string | null) => void;
    createCategory: (name: string) => Promise<CategoryResult>;
    renameCategory: (id: string, name: string) => Promise<CategoryResult>;
    deleteCategory: (id: string, reassignTo?: string) => Promise<CategoryResult>;
}

export default function AgentHero({
    t, ro = false,
    avatar, updateAvatar,
    name, updateName, flushNow,
    description, updateDescription,
    tiers, selectedTier,
    language = null, locale = 'en',
    categoryId = null, categories = null, categoriesState = READ.OK,
    updateCategory, createCategory, renameCategory, deleteCategory,
}: AgentHeroProps) {
    const tierLabel = tierLabelOf(t, selectedTier, tiers);
    const languageLabel = languageChipLabel(language, locale);
    // When the category tag appears.
    //
    // EMPTY AND UNREADABLE ARE TWO THINGS, and here they coincided: a 403 or a
    // network error on /agents/categories landed on `[]`, exactly like "this
    // org has no categories". Consequence 1: the tag of an agent THAT has one
    // disappeared without a message, and since A3 this is the only place in the
    // editor where the category can be seen or set. Consequence 2: an agent
    // without a category got an authoritative-looking dropdown with only "No
    // category", after which the only possible action is "+", and the owner
    // creates a duplicate of a category that does exist.
    //
    // So: only a READ list draws the picker. If it could not be read, the tag says
    // so, and only if this agent carries one, because about an agent without a
    // category there is nothing to report.
    const readCategories = categoriesState === READ.OK && Array.isArray(categories);
    const showCategory = readCategories && typeof updateCategory === 'function';
    const categoryUnreadable = categoriesState === READ.ERROR && !!categoryId;

    return (
        // `inert` (React 19 native) blocks mouse AND keyboard for the entire
        // subtree without touching the layout. Unlike fieldset[disabled], whose
        // display:contents no browser honours.
        <div className="max-w-4xl mx-auto px-10 pt-8" inert={ro || undefined} data-testid="agent-hero">
            <div className="flex items-start gap-4">
                {/* The pencil badge is DECORATION on a button that was already there. It
                    catches no clicks itself (`pointer-events-none`), so the whole
                    tile remains one hit area. In read-only mode it disappears: the
                    tile is then `inert`, and drawing a pencil above something that
                    cannot be edited is a promise that breaks. */}
                <div className="relative shrink-0">
                    <AvatarPicker t={t} avatar={avatar} onChange={updateAvatar} size="hero" />
                    {!ro && (
                        <span
                            data-testid="agent-hero-avatar-badge"
                            aria-hidden="true"
                            className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full flex items-center justify-center pointer-events-none border border-[var(--border-default)] bg-[var(--bg-card,#fff)] text-[var(--text-secondary)] shadow-sm"
                        >
                            <Pencil size={11} />
                        </span>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <input
                        value={name}
                        onChange={(e) => updateName(e.target.value)}
                        onBlur={flushNow}
                        className="w-full text-3xl font-semibold bg-transparent outline-none text-[var(--text-primary)] py-1 px-2 -mx-2 rounded-lg hover:bg-[var(--bg-secondary)] focus:bg-[var(--bg-secondary)] transition"
                        placeholder={t('agent_wizard.builder.name_placeholder')}
                    />
                    {(showCategory || categoryUnreadable || tierLabel || languageLabel) && (
                        <div className="flex flex-wrap items-center gap-2 mt-2">
                            {showCategory && (
                                <CategoryField
                                    t={t}
                                    variant="tag"
                                    value={categoryId}
                                    categories={categories}
                                    onChange={updateCategory}
                                    onCreate={createCategory}
                                    onRename={renameCategory}
                                    onDelete={deleteCategory}
                                />
                            )}
                            {categoryUnreadable && (
                                <HeroChip
                                    Icon={FolderOpen}
                                    testId="agent-hero-category-unreadable"
                                    title={t('agent_studio.hero.category_unreadable_title', 'The category list could not be read, so this category has no name here')}
                                >
                                    {t('agent_studio.hero.category_unreadable', 'Category unavailable')}
                                </HeroChip>
                            )}
                            {tierLabel && (
                                <HeroChip Icon={Gauge} testId="agent-hero-tier" title={t('agent_studio.hero.tier_title', 'Model tier')}>
                                    {tierLabel}
                                </HeroChip>
                            )}
                            {languageLabel && (
                                <HeroChip Icon={Languages} testId="agent-hero-language" title={t('agent_studio.hero.language_title', 'Answers in')}>
                                    {languageLabel}
                                </HeroChip>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {/* De omschrijving staat er ALTIJD — zie de docblock. */}
            <div className="relative mt-4">
                <textarea
                    value={description}
                    onChange={(e) => {
                        updateDescription(e.target.value.slice(0, 300));
                        e.target.style.height = 'auto';
                        e.target.style.height = `${e.target.scrollHeight}px`;
                    }}
                    onFocus={(e) => { e.target.style.height = 'auto'; e.target.style.height = `${e.target.scrollHeight}px`; }}
                    onBlur={flushNow}
                    placeholder={t('agent_wizard.field.role_description_placeholder')}
                    aria-label={t('agent_wizard.builder.role_description_label', 'Role description')}
                    rows={2}
                    data-testid="agent-hero-description"
                    className="w-full bg-transparent border-none outline-none rounded-xl px-4 py-3 pb-6 -mx-4 text-[15px] leading-6 text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]/40 focus:bg-[var(--bg-secondary)]/40 transition resize-none overflow-hidden"
                />
                {/* Counter and destination in one line: the number says how much still fits,
                    the sentence says why it matters. See the docblock for what that
                    sentence is based on. */}
                <span
                    data-testid="agent-hero-description-counter"
                    className="absolute bottom-1.5 right-3 text-[10px] text-[var(--text-tertiary)] pointer-events-none"
                >
                    {t('agent_studio.hero.description_counter', '{count}/300 · Shown in the agent picker', {
                        count: (description || '').length,
                    })}
                </span>
            </div>
        </div>
    );
}
