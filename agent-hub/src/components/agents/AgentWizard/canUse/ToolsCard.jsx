import { ArrowUpRight, ChevronDown, Workflow } from 'lucide-react';
import React, { useMemo, useRef, useState } from 'react';
import CanUseCard, { EmptyRow, LinkButton, UnreadableNotice } from './CanUseCard';
import { READ } from './canUseFacts';
import { CHOOSER_SECTION, chooserRequest } from './toolChooser';
import { ACT_AS, ACT_AS_KIND, CONFIRM } from './toolGrants';
import { getIntegrationIcon } from '../../../../config/integrationIcons';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import { actionLabelMap } from '../../../automation/Builder/flow/appLabels';
import AnchoredMenu from '../../../shared/AnchoredMenu';
import SegmentedControl from '../../../shared/SegmentedControl';
import { SECTION_LBL } from '../../../shell/sidebar/sidebarTokens';

/**
 * De Tools-kaart van de tab "Kan gebruiken" — wat de agent in ándere systemen
 * mag doen (Agents-artboard 1a, A2 stap 3).
 *
 * Eén rij per app: hoeveel van zijn acties aanstaan, welke werkwoorden dat
 * zijn, in wiens naam de app draait, en of een mens eerst ja moet zeggen. De ↗
 * opent de kiezer op díé app.
 *
 * ── DRIE VERSMALLINGEN, ALLE DRIE VAN DE RUNTIME OVERGENOMEN ────────
 * De feiten komen uit `toolGrants.js`, dat `server/core/agentRuntime/
 * toolPolicy.js` regel voor regel spiegelt. Deze kaart tekent ze, en tekent
 * daarbij drie dingen die eruitzien als strengheid maar eerlijkheid zijn:
 *
 *   1. VERSTUURT ⇒ VERGRENDELD. Een app die kan mailen, posten of uitnodigen
 *      staat op "eerst bevestigen" en de schakelaar zit vast. Dat is geen
 *      keuze die de kaart afneemt: `confirmForTool` beslist bij dispatch op
 *      het effect en zegt daar altijd `ask`. Een schakelaar die "direct" toont
 *      zou een belofte tonen die niemand nakomt.
 *   2. ONBEKEND EFFECT ⇒ OOK VERGRENDELD. Zonder catalogus weten we niet wat
 *      een actie doet. Dan telt onbekend als "het verstuurt" — precies wat
 *      `normaliseToolsConfig` doet als de attributie stuk is.
 *   3. GEEN LEEN-GRANT ⇒ GEEN EIGENAAR-OPTIE. En "ik kon de grants niet lezen"
 *      valt aan dezelfde kant: dat is geen ja.
 *
 * ── EN ÉÉN PLEK WAAR DE KAART GELIJK KREEG (A2-2) ───────────────────
 * De capsule tekent "As: the person asking" zodra er geen `actAs` is
 * opgeslagen. Dat was tot A2-2 een belofte die de runtime niet nakwam:
 * `mayLendOwnerConnection` gaf voor een app zónder entry `true` en de verbinding
 * van de EIGENAAR ging alsnog de deur uit. De runtime is nu de kaart gevolgd —
 * alleen een opgeslagen ja leent — en dat is een gedragswijziging voor
 * bestaande agents. Die hoort niet stil te gebeuren, dus de rij zegt het:
 *   `ownerLendingUnset`     de agent is gecureerd, hier staat niets, en de
 *                           geleende verbinding wordt daarom NIET meer gebruikt;
 *   `ownerLendsUncurated`   niemand cureerde deze agent, dus de runtime leent
 *                           hier nog wél — de opt-in-grens, hardop.
 *
 * ── EEN MISLUKTE CATALOGUS IS GEEN LEGE KAART ───────────────────────
 * De GRANTS staan in de agentconfig en die hebben we altijd. Valt de catalogus
 * weg, dan blijven de rijen staan — zonder tellingen, zonder werkwoorden, met
 * een regel erboven die zegt wat er ontbreekt. Wegfilteren zou beweren dat de
 * agent die apps niet heeft, en dat is de enige van de drie antwoorden die
 * onwaar is.
 *
 * ── WAT HET ONTWERP NIET KRIJGT ─────────────────────────────────────
 * Geen "mag naar scherm sturen"-rij: agent-naar-app-navigatie bestaat niet in
 * dit product, en een rij die een vermogen suggereert dat er niet is, is
 * erger dan een ontbrekende rij.
 */

/** Waarschuwingstekst onder een rij — één regel, altijd in de waarschuwkleur. */
function RowWarning({ children, testId }) {
    return <div data-testid={testId} className="text-[12px]" style={{ color: 'var(--warning)' }}>{children}</div>;
}

/**
 * De leen-melding onder een rij (A2-2).
 *
 * De capsule zegt "As: the person asking" zodra er niets is opgeslagen, en tot
 * A2-2 leende de runtime daar tóch de verbinding van de eigenaar uit. Die poort
 * is dicht, maar dat is een gedragswijziging voor bestaande agents — dus staat
 * hier wat er met díé rij gebeurd is. De twee gevallen sluiten elkaar uit: de
 * opt-in-grens (`curated`) scheidt ze.
 *
 * De REMEDIE staat er alleen als hij bestaat: een app die verstuurt krijgt
 * nooit "As: you", en een uitweg noemen die de kiezer weigert is dezelfde
 * belofte-zonder-dekking als het gat zelf. Dat gold voor de ene tak wél en voor
 * de andere niet: de uncurated-zin had de uitweg IN de zin gebakken, zonder de
 * `canActAsOwner`-poort — dus op elke verzendende app (Gmail, Outlook, LinkedIn,
 * SignRequest) noemde de kaart een menu-item dat er niet is en dat normalisatie
 * sowieso terugdraait.
 */
function LendingNotice({ t, row }) {
    if (row.ownerLendingUnset) {
        return (
            <RowWarning testId="agent-tool-lending-unset">
                {t('agent_studio.can_use.act_as_lending_unset', 'You lent a connection for this app, but nothing is set here — so it no longer borrows it and everyone uses their own.')}
                {row.canActAsOwner && ` ${t('agent_studio.can_use.act_as_lending_unset_fix', 'Choose “As: you” to lend it again.')}`}
            </RowWarning>
        );
    }
    if (row.ownerLendsUncurated) {
        return (
            <RowWarning testId="agent-tool-lending-uncurated">
                {t('agent_studio.can_use.act_as_lending_uncurated', 'Nothing has been picked for this agent yet, so it still runs on your lent connection here. As soon as anything is picked, that stops.')}
                {row.canActAsOwner && ` ${t('agent_studio.can_use.act_as_lending_uncurated_fix', 'Choose “As: you” to keep lending it.')}`}
            </RowWarning>
        );
    }
    return null;
}

/**
 * Hoeveel werkwoorden een rij toont voordat hij "+3" zegt. Vier is wat er in
 * de tweede kolom past zonder af te kappen op een half woord.
 */
const MAX_VERBS = 4;

/**
 * De werkwoorden van een rij: "Search · Compose · Create draft".
 *
 * `actionLabelMap` (de builder-ribbon) haalt het app-woord voor de naam
 * weg — "gmail search" wordt "Search" — want de app staat al in kolom één.
 * Diezelfde functie hergebruiken in plaats van hier opnieuw te knippen is de
 * hele reden dat die module bestaat.
 */
function useVerbs(row, app) {
    return useMemo(() => {
        if (!app || !Array.isArray(app.actions) || !Array.isArray(row.grantedNames)) return null;
        const labels = actionLabelMap(app.actions.map(a => ({ tool: a.name, label: a.label })));
        return row.grantedNames.map(name => labels.get(name) || name).filter(Boolean);
    }, [app, row.grantedNames]);
}

/**
 * De "Als:"-capsule.
 *
 * Een app zonder gebruikersverbinding (websearch, ingebouwde tools,
 * platformdiensten) krijgt een STATISCHE capsule zonder dropdown, en er wordt
 * geen `actAs` opgeslagen: een keuze die niets stuurt is precies de opgeslagen
 * belofte zonder handhaving die toolPolicy.js verbiedt.
 */
function ActAsCapsule({ t, row, ro, onChange }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);

    if (row.actAsKind === ACT_AS_KIND.PLATFORM) {
        return (
            <span
                data-testid="agent-tool-actas-static"
                title={t('agent_studio.can_use.act_as_platform_help', 'This app uses no personal connection.')}
                className="inline-flex items-center h-7 px-2.5 rounded-full text-[12px] border border-[var(--border-default)] text-[var(--text-tertiary)] whitespace-nowrap"
            >
                {t('agent_studio.can_use.act_as_platform', 'As: Bee Flow')}
            </span>
        );
    }

    // Onbekend is niet "Bee Flow" — dat zou een app die wél credentials leent
    // als platformdienst tekenen. Het is ook geen keuze, want we weten niet
    // waartussen. Dus: de standaard die de runtime hanteert, plus uitleg.
    if (row.actAsKind === ACT_AS_KIND.UNKNOWN) {
        return (
            <span
                data-testid="agent-tool-actas-unknown"
                title={t('agent_studio.can_use.act_as_unknown_help', 'Could not check whose connection this app uses, so it runs as the person asking.')}
                className="inline-flex items-center h-7 px-2.5 rounded-full text-[12px] border border-[var(--border-default)] text-[var(--text-tertiary)] whitespace-nowrap"
            >
                {t('agent_studio.can_use.act_as_viewer', 'As: the person asking')}
            </span>
        );
    }

    const label = row.actAs === ACT_AS.OWNER
        ? t('agent_studio.can_use.act_as_owner', 'As: you')
        : t('agent_studio.can_use.act_as_viewer', 'As: the person asking');

    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                disabled={ro}
                onClick={() => setOpen(v => !v)}
                aria-haspopup="menu"
                aria-expanded={open}
                data-testid="agent-tool-actas"
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-full text-[12px] border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 whitespace-nowrap max-w-full"
            >
                <span className="truncate">{label}</span>
                <ChevronDown size={12} aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={300}>
                <div className="p-2" role="menu" aria-label={t('agent_studio.can_use.act_as_menu', 'Choose whose connection this app uses')}>
                    <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={row.actAs !== ACT_AS.OWNER}
                        onClick={() => { onChange?.(ACT_AS.VIEWER); setOpen(false); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg-secondary)]"
                    >
                        <span className="block text-[13px] text-[var(--text-primary)]">
                            {t('agent_studio.can_use.act_as_viewer', 'As: the person asking')}
                        </span>
                        <span className="block text-[11px] text-[var(--text-tertiary)]">
                            {t('agent_studio.can_use.act_as_viewer_help', 'Everyone uses their own connection.')}
                        </span>
                    </button>
                    <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={row.actAs === ACT_AS.OWNER}
                        disabled={!row.canActAsOwner}
                        data-testid="agent-tool-actas-owner"
                        onClick={() => { onChange?.(ACT_AS.OWNER); setOpen(false); }}
                        className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-[var(--bg-secondary)] disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                        <span className="block text-[13px] text-[var(--text-primary)]">
                            {t('agent_studio.can_use.act_as_owner', 'As: you')}
                        </span>
                        <span className="block text-[11px] text-[var(--text-tertiary)]">
                            {row.canActAsOwner
                                ? t('agent_studio.can_use.act_as_owner_help', 'Everyone borrows your connection — never for actions that send.')
                                : t('agent_studio.can_use.act_as_owner_unavailable', 'You have not lent a connection for this app.')}
                        </span>
                    </button>
                </div>
            </AnchoredMenu>
        </>
    );
}

/** Eén app-rij. Grid `1fr 1fr 220px 32px`, zoals het artboard hem tekent. */
function ToolRow({ t, ro, row, app, onChangeConfirm, onChangeActAs, onOpenChooser }) {
    const verbs = useVerbs(row, app);
    const shownVerbs = verbs ? verbs.slice(0, MAX_VERBS) : null;
    const restVerbs = verbs ? verbs.length - (shownVerbs?.length || 0) : 0;

    return (
        <div
            data-testid="agent-tool-row"
            className="grid items-start gap-3 px-4 py-3"
            style={{ gridTemplateColumns: '1fr 1fr 220px 32px' }}
        >
            <div className="min-w-0 flex items-start gap-2.5">
                {/* `getIntegrationIcon` geeft een ELEMENT terug, geen
                    component — zelfde gebruik als shared/AppActionPicker. */}
                <span className="mt-0.5 w-4 h-4 flex-shrink-0 flex items-center justify-center" aria-hidden="true">
                    {getIntegrationIcon(row.appId)}
                </span>
                <span className="min-w-0">
                    <span className="block text-[13px] text-[var(--text-primary)] truncate">{row.label}</span>
                    <span className="block text-[12px] text-[var(--text-tertiary)]">
                        {row.totalActions === null
                            ? t('agent_studio.can_use.actions_unknown', 'actions unknown')
                            : nOf(
                                t, 'agent_studio.can_use.n_of_m_actions', row.totalActions,
                                '{granted} of {count} action', '{granted} of {count} actions',
                                { granted: row.grantedCount },
                            )}
                    </span>
                    {row.available === false && (
                        <RowWarning>
                            {/* Verschillende feiten, verschillende zinnen. Maar
                                alleen als de MEETING er één aanwijst: `browse_web`
                                zit achter een docker-probe ÉN achter het
                                org-entitlement, dus "deze installatie heeft hem
                                niet" zou daar een bewering zijn die nergens uit
                                volgt. Bij meer dan één mogelijke oorzaak noemt de
                                kaart ze allebei in plaats van er één te kiezen. */}
                            {row.availabilityKinds && row.availabilityKinds.length > 1
                                ? t('agent_studio.can_use.app_unavailable_mixed', 'Not available here — this installation may not have it, or your account may not use it. The agent gets nothing from this app.')
                                : row.availabilityKind === 'installation'
                                    ? t('agent_studio.can_use.app_unavailable_installation', 'Not available on this installation — the agent gets nothing from this app.')
                                    : row.availabilityKind === 'permission'
                                        ? t('agent_studio.can_use.app_unavailable_permission', 'Your account may not use this app — the agent gets nothing from it.')
                                        : t('agent_studio.can_use.app_unavailable', 'Not connected for you — the agent gets nothing from this app.')}
                        </RowWarning>
                    )}
                    {row.narrowedBy && row.narrowedBy.length > 0 && (
                        <RowWarning testId="agent-tool-narrowed-by">
                            {/* Twee rijen over dezelfde tools: de runtime laat
                                ELKE app die de naam levert meebeslissen, dus de
                                strengste wint. Zonder deze zin ziet de eigenaar
                                alleen een lager getal en niet waarom. */}
                            {t('agent_studio.can_use.app_narrowed_by',
                                'Another app with the same tools limits this one further.')}
                        </RowWarning>
                    )}
                    {row.ownerRefused && (
                        <RowWarning>
                            {t('agent_studio.can_use.act_as_owner_refused', 'Saved as “you”, but there is no lent connection for this app — it runs as the person asking.')}
                        </RowWarning>
                    )}
                    <LendingNotice t={t} row={row} />
                </span>
            </div>

            <div className="min-w-0 text-[12px] text-[var(--text-tertiary)]">
                {shownVerbs === null
                    ? null
                    : shownVerbs.length === 0
                        ? t('agent_studio.can_use.app_no_actions', 'Nothing switched on')
                        : (
                            <>
                                {shownVerbs.join(' · ')}
                                {restVerbs > 0 && (
                                    <span className="ml-1">
                                        {t('agent_studio.can_use.more_actions', '+{count} more', { count: restVerbs })}
                                    </span>
                                )}
                            </>
                        )}
            </div>

            <div className="flex flex-col items-start gap-2 min-w-0">
                <ActAsCapsule t={t} row={row} ro={ro} onChange={(next) => onChangeActAs?.(row.appId, next)} />
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('agent_studio.can_use.confirm_group', 'When this app is used')}
                    value={row.confirm}
                    disabled={ro || row.confirmLocked}
                    onChange={(next) => onChangeConfirm?.(row.appId, next)}
                    options={[
                        { value: CONFIRM.DIRECT, label: t('agent_studio.can_use.confirm_direct', 'Direct') },
                        { value: CONFIRM.ASK, label: t('agent_studio.can_use.confirm_ask', 'Confirm first') },
                    ]}
                />
                {row.confirmLocked && (
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {row.sends === true
                            ? t('agent_studio.can_use.confirm_locked_sends', 'This app can send, so a person always confirms first.')
                            : t('agent_studio.can_use.confirm_locked_unknown', 'Could not read what these actions do, so a person confirms first.')}
                    </span>
                )}
            </div>

            <button
                type="button"
                data-testid="agent-tool-open"
                onClick={() => onOpenChooser?.(chooserRequest(CHOOSER_SECTION.APPS, { appId: row.appId }))}
                aria-label={t('agent_studio.can_use.open_app_actions', 'Choose actions for this app')}
                title={t('agent_studio.can_use.open_app_actions', 'Choose actions for this app')}
                className="flex items-center justify-center w-8 h-8 rounded-lg border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] transition flex-shrink-0"
            >
                <ArrowUpRight size={16} aria-hidden="true" />
            </button>
        </div>
    );
}

/**
 * De band "Automations als tool" — routines die de agent zelf mag starten.
 *
 * De parampillen komen uit `trigger.parametersSchema`, hetzelfde schema
 * waaruit `automationToTool` de tool-signatuur rendert. Wat hier staat is dus
 * letterlijk wat het model moet invullen, niet een parafrase ervan.
 */
function AutomationRow({ t, row }) {
    return (
        <div data-testid="agent-automation-row" className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true">
                <Workflow size={14} />
            </span>
            <div className="min-w-0 flex-1">
                <div className={`text-[13px] truncate ${row.readable ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)] italic'}`}>
                    {row.name || t('agent_studio.can_use.automation_unnamed', 'Routine')}
                </div>
                <div className="text-[12px] text-[var(--text-tertiary)] flex items-center gap-1.5 flex-wrap mt-0.5">
                    <span>
                        {row.confirm === CONFIRM.ASK
                            ? t('agent_studio.can_use.confirm_ask', 'Confirm first')
                            : t('agent_studio.can_use.confirm_direct', 'Direct')}
                    </span>
                    {row.readable && (
                        <>
                            <span aria-hidden="true">·</span>
                            {row.params.length === 0 ? (
                                <span>{t('agent_studio.can_use.automation_no_params', 'asks for nothing')}</span>
                            ) : (
                                <>
                                    <span>{t('agent_studio.can_use.automation_asks_for', 'asks for')}</span>
                                    {row.params.map(p => (
                                        <span
                                            key={p.name}
                                            data-testid="agent-automation-param"
                                            title={p.required ? t('agent_studio.can_use.param_required', 'required') : undefined}
                                            className="inline-flex items-center px-1.5 py-px rounded-md border border-[var(--border-default)] text-[11px] text-[var(--text-secondary)]"
                                        >
                                            {p.name}
                                            {p.required && <span aria-hidden="true" className="ml-0.5" style={{ color: 'var(--error)' }}>*</span>}
                                        </span>
                                    ))}
                                </>
                            )}
                        </>
                    )}
                </div>
                {row.readable === false && (
                    <RowWarning>
                        {t('agent_studio.can_use.automation_row_unreadable', 'Granted, but this routine could not be read — so what it does is unknown.')}
                    </RowWarning>
                )}
                {row.callable === false && (
                    <RowWarning>
                        {t('agent_studio.can_use.automation_not_callable', 'This routine has no agent trigger, so the agent is never offered it.')}
                    </RowWarning>
                )}
            </div>
        </div>
    );
}

export default function ToolsCard({
    t, ro = false,
    rows = [],
    apps = null,
    catalogState = READ.OK,
    catalogDegraded = false,
    onRetryCatalog,
    lentState = READ.OK,
    onRetryLent,
    automationRows: autoRows = [],
    automationsState = READ.OK,
    onChangeConfirm, onChangeActAs, onOpenChooser,
}) {
    const appById = useMemo(() => {
        const map = new Map();
        for (const app of Array.isArray(apps) ? apps : []) if (app && app.id) map.set(app.id, app);
        return map;
    }, [apps]);

    // "Deze agent heeft geen apps" is een CONFIG-vraag: de rijen komen uit
    // `enabledIntegrations` en `config.tools`, en die hebben we altijd. Zo mag
    // die zin er staan zonder op de catalogus te wachten — en andersom hoort
    // de waarschuwing alleen te staan als er iets IS dat we niet konden
    // beschrijven.
    const nothingOn = rows.length === 0 && autoRows.length === 0;
    // De leen-lezing is alleen nieuws voor een rij die een gebruikersverbinding
    // gebruikt; bij een agent met alleen platformtools zou de waarschuwing over
    // iets gaan wat er niet is.
    const anyUserConnection = rows.some(r => r.actAsKind === ACT_AS_KIND.USER);

    return (
        <CanUseCard
            kind="app"
            testId="agent-tools-card"
            title={t('agent_studio.can_use.tools_title', 'Tools')}
            subtitle={t('agent_studio.can_use.tools_sub', 'What it may do in other apps')}
            action={!ro && (
                <LinkButton
                    testId="agent-tools-link"
                    label={t('agent_studio.can_use.link', 'Link')}
                    onClick={() => onOpenChooser?.(chooserRequest(CHOOSER_SECTION.APPS))}
                />
            )}
        >
            {catalogState === READ.ERROR && (
                <UnreadableNotice
                    testId="agent-tools-unreadable"
                    message={t('agent_studio.can_use.tools_unreadable', 'Could not load the app catalogue, so the action counts and what each action does are missing here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryCatalog}
                />
            )}
            {catalogState === READ.OK && catalogDegraded && (
                <UnreadableNotice
                    testId="agent-tools-degraded"
                    message={t('agent_studio.can_use.tools_degraded', 'Could not check which apps you are allowed to use, so nothing is claimed about that here.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryCatalog}
                />
            )}
            {lentState === READ.ERROR && anyUserConnection && (
                <UnreadableNotice
                    testId="agent-tools-lending-unreadable"
                    message={t('agent_studio.can_use.lending_unreadable', 'Could not read which connections you lent to this agent, so “as you” is not offered.')}
                    retryLabel={t('agent_studio.retry', 'Retry')}
                    onRetry={onRetryLent}
                />
            )}

            {rows.map(row => (
                <ToolRow
                    key={row.appId}
                    t={t}
                    ro={ro}
                    row={row}
                    app={appById.get(row.appId) || null}
                    onChangeConfirm={onChangeConfirm}
                    onChangeActAs={onChangeActAs}
                    onOpenChooser={onOpenChooser}
                />
            ))}

            {autoRows.length > 0 && (
                <div className="px-4 pt-3 pb-1">
                    <span className={SECTION_LBL} data-testid="agent-automations-band">
                        {t('agent_studio.can_use.automations_band', 'Automations as a tool')}
                    </span>
                </div>
            )}
            {automationsState === READ.ERROR && autoRows.length > 0 && (
                <UnreadableNotice
                    testId="agent-automations-unreadable"
                    message={t('agent_studio.can_use.automations_unreadable', 'Could not load the routines, so their names and inputs are missing here.')}
                />
            )}
            {autoRows.map(row => <AutomationRow key={row.id} t={t} row={row} />)}

            {nothingOn && (
                <EmptyRow
                    testId="agent-tools-empty"
                    message={t('agent_studio.can_use.tools_empty', 'No apps switched on yet — this agent answers, it does not act.')}
                />
            )}
        </CanUseCard>
    );
}
