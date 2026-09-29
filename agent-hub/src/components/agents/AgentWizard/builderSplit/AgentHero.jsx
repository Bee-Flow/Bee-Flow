import { FolderOpen, Gauge, Languages, Pencil } from 'lucide-react';
import React from 'react';
import { TIER_META, customTierMeta } from '../../../licensing/tierMeta';
import CategoryField from '../CategoryField';
import { READ } from '../canUse/canUseFacts';
import AvatarPicker from '../pickers/AvatarPicker';

/**
 * AgentHero — de identiteitsRIJ van de agent-editor, direct onder de gedeelde
 * kop en BOVEN de kaarten van de Rol-tab (Bee Flow Builder herontwerp, sep
 * 2026; Agents-artboard 1b/1c, A2 stap 1 + A3 deel B).
 *
 * Wat er staat, altijd zichtbaar:
 *   56px tegel   het avatar (AvatarPicker, size="hero") met een pencil-badge,
 *                zodat "hier valt te klikken" niet iets is dat je moet raden
 *   naam         hetzelfde invoerveld als voorheen
 *   categorie    `CategoryField variant="tag"` — dezelfde component als de
 *                oude Rol-tab gebruikte, op chipformaat naast de chips
 *   omschrijving NIET achter een "Add description"-knop. Een agent zonder
 *                omschrijving is een agent waarvan niemand weet waarvoor hij
 *                is; de plek waar dat te repareren valt mag niet zelf
 *                verstopt zitten. Leeg toont een placeholder.
 *   chips        de tier (gauge + TIER_META-label) en de taal uit
 *                `persona.language`
 *
 * De chips zijn LEZERS, geen bedieningselementen: de tier verander je met
 * de ModelTierSelector in de Rol-tab, de taal met de persona. Ze staan hier
 * omdat ze samen met naam en omschrijving beantwoorden "wie is dit" — en
 * omdat een agent die stilletjes in het Frans antwoordt anders pas opvalt
 * als een klant het meldt. De categorietag is wél bediening: hij staat hier
 * omdat hij bij de identiteit hoort ("Sales ▾"), en hij stond op de Rol-tab
 * in de weg van de vijf rolkaarten.
 *
 * Een chip die we niet kunnen onderbouwen, tonen we niet: geen tier in de
 * lijst ⇒ geen tierchip, geen (benoembare) taalcode ⇒ geen taalchip. Zie
 * `languageChipLabel`.
 *
 * DE TELLER ONDER DE OMSCHRIJVING ZEGT WAAR DE TEKST TERECHTKOMT, en dat is
 * nagegaan: `AgentMarketplace`'s kaart tekent `description` onder de naam van
 * de agent (components/agents/AgentMarketplace.jsx, AgentCard), en die lijst is
 * wat mensen openen om een agent te kiezen. De lijst bevat de eigen agents én
 * de gepubliceerde (AgentHub/useAgentHubData.refreshAgents), dus de zin geldt
 * ook vóór publicatie. Op Android geldt hij ook: `mobile/.../AgentRow.tsx` zet
 * `agent.description` als subtitel van elke rij. Zou dat ooit niet meer
 * kloppen, dan moet deze zin weg — een uitleg die niet waar is, is erger dan
 * geen uitleg.
 */

/**
 * De i18n-sleutel per ingebouwde tier. TIER_META draagt Engelse constanten
 * (het is ook de bron voor de dropdown en de chatbadge); hier krijgen ze hun
 * vertaling. Eén LITERALE t()-aanroep per tier, want een sleutel die uit een
 * variabele wordt samengesteld is voor de i18n-guard niet te controleren —
 * en een tierchip die "tier.fast" toont is erger dan een Engelse "Fast".
 */
function tierLabelOf(t, key, tiers) {
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
            // Een custom tier draagt de naam die de beheerder zelf typte —
            // gebruikersdata, geen productcopy, dus niet door t() heen.
            return key && key.startsWith('custom:') ? customTierMeta(key, tiers?.[key]).label : null;
    }
}

/**
 * De naam van een taalcode, of null.
 *
 * Spiegelt `server/core/agentRuntime/personaPrompt.js:languageNameOf`: wat we
 * niet kunnen benoemen, benoemen we niet. De server slaat alleen codes op die
 * hij kón benoemen, dus in de praktijk kost weigeren niets — en een chip met
 * een rauwe code erin ("xx-YZ") is geen taal maar een lek uit de database.
 * `Intl.DisplayNames` bestaat niet in elke omgeving, dus alles zit in een
 * try/catch: geen naam ⇒ geen chip.
 */
export function languageChipLabel(code, locale = 'en') {
    if (typeof code !== 'string' || !code.trim()) return null;
    const base = code.trim().toLowerCase().split('-')[0];
    if (!/^[a-z]{2,3}$/.test(base)) return null;
    try {
        const name = new Intl.DisplayNames([locale || 'en'], { type: 'language' }).of(base);
        if (typeof name === 'string' && name && name.toLowerCase() !== base) return name;
    } catch (_) { /* geen ICU ⇒ geen naam ⇒ geen chip */ }
    return null;
}

/** De chipvorm van de hero: 24px hoog, hairline, tertiaire glyph. */
function HeroChip({ Icon, children, title, testId }) {
    return (
        <span
            data-testid={testId}
            title={title}
            className="inline-flex items-center gap-1.5 h-6 px-2 rounded-lg text-[12px] whitespace-nowrap border border-[var(--border-default)] bg-[var(--bg-card,transparent)] text-[var(--text-secondary)]"
        >
            <Icon size={12} aria-hidden="true" style={{ color: 'var(--text-tertiary)' }} />
            <span>{children}</span>
        </span>
    );
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
}) {
    const tierLabel = tierLabelOf(t, selectedTier, tiers);
    const languageLabel = languageChipLabel(language, locale);
    // Wanneer de categorietag verschijnt.
    //
    // LEEG EN ONLEESBAAR ZIJN TWEE DINGEN, en ze vielen hier samen: een 403 of
    // een netwerkfout op /agents/categories landde op `[]`, precies zoals "deze
    // org heeft geen categorieën". Gevolg 1: de tag van een agent DIE er een
    // heeft verdween zonder melding, en sinds A3 is dit de enige plek in de
    // editor waar de categorie te zien of te zetten is. Gevolg 2: een agent
    // zonder categorie kreeg een gezaghebbend ogende keuzelijst met alleen "No
    // category", waarna de enige mogelijke actie "+" is en de eigenaar een
    // duplicaat aanmaakt van een categorie die gewoon bestaat.
    //
    // Dus: alleen een GELEZEN lijst tekent de kiezer. Kon hij niet gelezen
    // worden, dan zegt de tag dat — en alleen als deze agent er een draagt,
    // want over een agent zonder categorie valt dan niets te melden.
    const readCategories = categoriesState === READ.OK && Array.isArray(categories);
    const showCategory = readCategories && typeof updateCategory === 'function';
    const categoryUnreadable = categoriesState === READ.ERROR && !!categoryId;

    return (
        // `inert` (React 19 native) blokkeert muis én toetsenbord voor de hele
        // subtree zonder de layout aan te raken — anders dan fieldset[disabled],
        // waarvan display:contents door geen browser wordt gehonoreerd.
        <div className="max-w-4xl mx-auto px-10 pt-8" inert={ro || undefined} data-testid="agent-hero">
            <div className="flex items-start gap-4">
                {/* De pencil-badge is DECORATIE op een knop die er al was: hij
                    vangt zelf geen klikken (`pointer-events-none`), zodat de
                    hele tegel één trefvlak blijft. Bij alleen-lezen verdwijnt
                    hij — de tegel is dan `inert`, en een potlood tekenen boven
                    iets wat niet te bewerken is, is een belofte die breekt. */}
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
                {/* Teller én bestemming in één regel: het getal zegt hoeveel er
                    nog kan, de zin zegt waarom het ertoe doet. Zie de docblock
                    voor waar die zin op gebaseerd is. */}
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
