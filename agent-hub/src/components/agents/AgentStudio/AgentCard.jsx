import { Bot, Trash2 } from 'lucide-react';
import React from 'react';
import AgentCardFooter from './AgentCardFooter';
import { CATEGORY, EDIT, categoryOf, countsOf, editVerdict } from './agentCardFacts';
import { DEFAULT_AGENT_EMOJI, isImageAvatar, pickAgentAvatar, resolveAvatarSrc } from '../../../utils/agentAvatar';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import { kindTileStyle } from '../../shared/kindColors';
import StatusActionPill from '../../shared/StatusActionPill';
import { audienceLabel, audienceModeOf, makeGroupNamer } from '../../shared/VisibilityCapsule';
import { publishedVersionOf } from '../AgentWizard/builderSplit/AgentEditorHeader';

/**
 * Eén agent in het overzicht (Bee Flow Builder-herontwerp, sep 2026;
 * Agents-artboard 1a, A5 deel C).
 *
 * Een kaart en geen tekstregel, omdat er vier vragen aan deze lijst gesteld
 * worden en er drie van open moesten worden geklikt: hoe heet hij, draait hij
 * al, wie mag hem zien, en waar praat hij eigenlijk uit. De kaart beantwoordt
 * ze in die volgorde — naam, statuspil, metaregel, drie pillen.
 *
 * ── TWEE PUBLICATIE-WERKWOORDEN ─────────────────────────────────────
 * De statuspil zegt LIVE/DRAFT op `published_version` (welke config de
 * runtime serveert). De metaregel zegt met wie hij gedeeld is op
 * `is_published` + `shared_groups` (het publiek). Dat zijn twee verschillende
 * vragen die allebei "publiceren" heten; ze staan naast elkaar om precies die
 * reden, met hun eigen woorden — `shared/VisibilityCapsule.audienceLabel` voor
 * het publiek, `StatusActionPill` voor de status.
 *
 * ── ÉÉN WAARSCHUWING PER KAART, EN DIE KOMT VAN DE SERVER ───────────
 * Hier stond een gestippelde `--error`-rij "No knowledge base", uitgerekend uit
 * de eigen kennis-nul. Dat was een tweede lezing van een regel die op de server
 * staat (core/agentRuntime/agentGrounding.js), en hij sprak hem tegen: een
 * config die de server als ONLEESBAAR boekt — bewust geen beschuldiging —
 * kreeg hier rood alarm. Bovendien stond hij op dezelfde kaart als de voetregel
 * die hetzelfde zegt, dus een nieuwe agent kreeg twee waarschuwingen voor iets
 * wat nog gebouwd wordt.
 *
 * Nu: de kennis-PIL toont de gemeten nul (een telling, geen bewering), en de
 * voetregel (`AgentCardFooter`) doet de bewering — uitsluitend op het woord dat
 * de server stuurde, en alleen binnen de afbakening die `cardFooter.js`
 * opschrijft.
 *
 * ── DE TOOLS-PIL IS EEN ONDERGRENS, EN ZEGT DAT ─────────────────────
 * Een agent zonder `config.tools.automations` is NIET gecureerd, en de runtime
 * biedt hem élke agent-callable automatisering van de vrager aan plus elke in de chat
 * gepubliceerde Step (core/integrations/integrationTools.js). "0 tools" was
 * daar het omgekeerde van de waarheid; `counts.toolsAtLeast` maakt er "at least
 * n tools" van.
 *
 * ── ÉÉN KAART, TWEE KNOPPEN, GEEN GENESTE KNOP ──────────────────────
 * De kaart zelf is één `<button>` (openen). De prullenbak is een BROERTJE dat
 * er absoluut overheen ligt: een knop in een knop is een toetsenbordval en
 * een raadsel voor de schermlezer.
 */
export default function AgentCard({
    t,
    agent,
    categories = [],
    orgGroups = [],
    viewerId = null,
    onOpen,
    onDelete = null,
    selected = false,
}) {
    const counts = countsOf(agent);
    const tf = filling(t);
    const verdict = editVerdict(agent);
    const cat = categoryOf(agent, categories);
    const version = publishedVersionOf(agent);
    const live = version > 0;
    const { tile, glyph } = kindTileStyle('agent', { size: 36, pct: 16 });
    // Alleen een EXPLICIETE `can_edit: true` geeft een prullenbak — zie EditBadge.
    const showDelete = !!onDelete && verdict === EDIT.YES;
    const avatar = pickAgentAvatar(agent) || DEFAULT_AGENT_EMOJI;

    // Het publiek in de woorden die de capsule ook in de editor gebruikt.
    const mode = audienceModeOf({ isPublished: !!agent?.is_published, sharedGroups: agent?.shared_groups });
    const audience = audienceLabel(t, mode, agent?.shared_groups, makeGroupNamer({ orgGroups }));

    // De metaregel, als lijst — een ontbrekend deel laat de scheidingstekens
    // niet achter ("Sales ·  · organisation").
    const meta = [];
    if (cat.state === CATEGORY.NAMED) meta.push(cat.name);
    // Een categorie die we niet konden thuisbrengen is niet "geen categorie".
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
                            ? <img src={resolveAvatarSrc(avatar)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'inherit' }} />
                            : avatar
                                ? <span style={{ fontSize: 18, lineHeight: 1 }}>{avatar}</span>
                                : <Bot style={glyph} />}
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                            {agent?.name || t('agent_studio.untitled', 'Untitled agent')}
                        </span>
                        <span className="block text-xs mt-0.5 truncate" style={{ color: 'var(--text-secondary)' }}>
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
                            // De sectie `config.tools` staat er wél maar is niet
                            // te lezen. Geen getal dus, en geen nul.
                            <CountPill n={null} label={t('agent_studio.card.tools_unreadable', 'Tools could not be read')} />
                        ) : (
                            <CountPill n={counts.tools} label={toolsLabel(tf, counts.tools, counts.toolsAtLeast)} />
                        )}
                    </span>
                ) : (
                    // Geen drie nullen: nul is een bewering, en die is hier niet
                    // gedaan — de config kon niet gelezen worden.
                    <span className="text-xs" style={{ color: 'var(--text-tertiary)' }} data-testid="agent-card-counts-unreadable">
                        {t('agent_studio.card.counts_unreadable', 'Configuration could not be read')}
                    </span>
                )}

                <AgentCardFooter agent={agent} viewerId={viewerId} />
            </button>

            {/* `can_edit !== false` was fail-open: `/agents/system` zet het veld
                niet, en zo'n rij hield de knop. Onbekend versmalt. */}
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
 * t() met de placeholders er ALTIJD ingevuld. Dezelfde reden en dezelfde vorm
 * als `tx` in shared/VisibilityCapsule.jsx en builderSplit/AgentEditorHeader.jsx:
 * de echte vertaler interpoleert zelf, een meegegeven `t` (tests, embeds) niet,
 * en een pil die letterlijk "{count} tools" zegt is erger dan geen pil.
 */
function tx(t, key, fallback, params) {
    let value = t(key, fallback, params);
    if (typeof value !== 'string') value = fallback;
    for (const [k, v] of Object.entries(params || {})) {
        value = value.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
    return value;
}

/**
 * "1 knowledge base" / "3 knowledge bases" — enkelvoud en meervoud zijn twee
 * SLEUTELS, nooit een "(s)" achter een woord.
 *
 * DRIE FUNCTIES MET LETTERLIJKE SLEUTELS, geen `{key, one, many}`-tabel. Die
 * tabel bereikte `t()` als `pluralKey(spec.key, count)` — een variabele — en
 * dat is precies de klasse "sleutel reist als data" waar de i18n-guard blind
 * voor is: hij meldde uit dit bestand alleen `agent_studio.card.version`, dus
 * de zes plural-sleutels konden voor altijd Engels blijven zonder dat er een
 * test rood werd. Het buurbestand AgentCardFooter.jsx roept `nOf` met literals
 * aan en wordt daar wél volledig voor gemeld.
 */
/**
 * `t` met de placeholders er ALTIJD ingevuld, in de vorm die `nOf` verwacht.
 *
 * Hij wordt HIER gemaakt en niet in de aanroep: de i18n-guard leest een
 * helper-aanroep met `\\b(nOf|tx|…)\\(([^()]*)\\)`, en dat patroon breekt op de
 * eerste haak binnen de aanroep. Een `nOf(filling(t), …)` of een
 * `nOf(t, 'key', Number(n) || 0, …)` zou de hele aanroep onzichtbaar maken —
 * precies het gat dat de `{key, one, many}`-tabel hiervoor ook had.
 */
function filling(t) {
    return (key, fallback, params) => tx(t, key, fallback, params);
}

function knowledgeLabel(tf, n) {
    const count = Number(n) || 0;
    return nOf(tf, 'agent_studio.card.n_knowledge', count, '{count} knowledge base', '{count} knowledge bases');
}

function skillsLabel(tf, n) {
    const count = Number(n) || 0;
    return nOf(tf, 'agent_studio.card.n_skills', count, '{count} skill', '{count} skills');
}

/**
 * De tools-pil. `atLeast` betekent dat het getal een ONDERGRENS is: deze agent
 * heeft geen automation-curatie, dus de runtime legt er élke agent-callable
 * automatisering van de vrager bovenop plus elke gepubliceerde Step.
 */
function toolsLabel(tf, n, atLeast) {
    const count = Number(n) || 0;
    return atLeast
        ? nOf(tf, 'agent_studio.card.n_tools_min', count, 'at least {count} tool', 'at least {count} tools')
        : nOf(tf, 'agent_studio.card.n_tools', count, '{count} tool', '{count} tools');
}

/** Eén telpil. Nul blijft staan — dat is een gemeten nul, geen ontbrekende. */
function CountPill({ n, label }) {
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
 * BFSF-271. `can_edit === false` als enige test was fail-open: `/agents/system`
 * zet het veld niet, en zo'n rij hield stilzwijgend zijn bewerk-affordances.
 * Onbekend versmalt én zegt dat het onbekend is — een "View only" over een rij
 * waarvan we het antwoord niet hebben zou een bewering zijn.
 */
function EditBadge({ t, verdict }) {
    if (verdict === EDIT.YES) return null;
    const label = verdict === EDIT.NO
        ? t('agent_studio.view_only', 'View only')
        : t('agent_studio.edit_unknown', 'Edit rights unknown');
    return (
        <span
            data-testid={verdict === EDIT.NO ? 'agent-card-view-only' : 'agent-card-edit-unknown'}
            className="text-[9px] px-1.5 py-0.5 rounded font-semibold whitespace-nowrap"
            style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-default)',
                color: 'var(--text-tertiary)',
            }}
        >
            {label}
        </span>
    );
}
