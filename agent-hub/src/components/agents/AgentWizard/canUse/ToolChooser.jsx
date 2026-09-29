import React, { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { READ } from './canUseFacts';
import { chooserInitialSelection, commitSelection, foldSharedApps, selectionDelta } from './toolChooserModel';
import { hasCuratedGrants } from './toolGrants';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import AppActionPicker from '../../../shared/AppActionPicker';
import Modal from '../../../shared/Modal';

/**
 * De TOOL-KIEZER van de agent-editor (Agents-artboard 1f, A2 stap 4).
 *
 * De schil is `shared/AppActionPicker` — dezelfde overlay als de AI-stap van de
 * automations-builder en de connectorkiezer van App Studio. Er komt hier dus
 * geen derde kiezer naast de twee die er al zijn; wat dit bestand toevoegt is
 * de BINDING: welke selectie erin gaat, wat er bij toepassen uit komt, en de
 * zinnen eromheen.
 *
 * ── WAAROM DIT NIET DE PLATTE `selected` GEBRUIKT ───────────────────
 * De schil kende tot deze stage één selectiemodel: een platte lijst
 * actienamen. Die vorm kan "over deze app is niets gezegd" en "deze app mag
 * niets" niet uit elkaar houden — en dat is precies het verschil waar de
 * agent-grants op draaien (bevinding 1 van de A1b-rechtenlaagreview: de lege
 * sectie werd weggegooid en las daarna als "nooit gekozen", dus álle routines
 * mochten weer). Daarom geeft deze kiezer een `selection`-Map mee: per app een
 * eigen verzameling, met een lege verzameling als échte keuze.
 *
 * ── ÉÉN OPSLAG PER SESSIE ───────────────────────────────────────────
 * Elk vinkje muteert alleen lokale state. Pas op "toepassen" gaat er één
 * `patchConfig` de deur uit, met de grants-map én de app-niveau lijst erin.
 * Dat is niet alleen zuiniger: een agent die tijdens het kiezen na elk vinkje
 * wordt opgeslagen, staat halverwege een gedachte in productie.
 *
 * ── WAT DE KIEZER HARDOP ZEGT ───────────────────────────────────────
 * De eerste entry in de grants-map zet de agent in het bevestigingsregime
 * (`hasCuratedGrants` in toolPolicy.js: daarvóór kijkt de runtime niet eens
 * naar de map). Voor een agent die vandaag onbeheerd een mailroutine draait is
 * dat een merkbare gedragswijziging achter één klik. Die staat daarom in de
 * voet, vóór het opslaan, en niet in een release-noot achteraf.
 *
 * ── EEN MISLUKTE CATALOGUS IS GEEN LEGE KIEZER ──────────────────────
 * Zonder catalogus zijn er geen acties om uit te kiezen. Een lege overlay zou
 * dan "je hebt geen apps" beweren; deze zegt dat de lijst niet gelezen kon
 * worden en biedt opnieuw proberen. Precies andersom als bij de Tools-KAART,
 * waar de grants uit de config komen en de rijen dus wél blijven staan.
 */

/**
 * Waarom deze app kan ontbreken, in één zin.
 *
 * `availabilityKind` komt van de catalogus (server/routes/agents/toolCatalog.js).
 * De kiezer-brede zin gaat over een verbinding die de gebruiker niet legde, en
 * dat is niet het enige dat "niet beschikbaar" kan betekenen: `browse_web` zit
 * achter een docker-probe, dus op de ene installatie is hij er en op de andere
 * niet. AFWEZIG, NIET BESCHIKBAAR OP DEZE INSTALLATIE en NIET TOEGEKEND zijn
 * drie verschillende dingen; hier wordt alleen gezegd welke waar is.
 *
 * `null` betekent "de gewone zin volstaat" — dat is ook waar een onbekende
 * soort op landt: een verzonnen uitleg is erger dan de algemene.
 */
function unavailableHintFor(t, app) {
    // Meer dan één mogelijke oorzaak ⇒ geen van de specifieke zinnen: die zou
    // een feit beweren dat de meting niet oplevert.
    if (app && Array.isArray(app.availabilityKinds) && app.availabilityKinds.length > 1) {
        return t('agent_studio.can_use.chooser_unavailable_mixed',
            'not available to you here');
    }
    switch (app && app.availabilityKind) {
        case 'installation':
            return t('agent_studio.can_use.chooser_unavailable_installation',
                'not available on this installation');
        case 'permission':
            return t('agent_studio.can_use.chooser_unavailable_permission',
                'not something your account may use');
        default:
            return null;
    }
}

/**
 * De apps zoals de kiezer ze toont.
 *
 * De NAAM valt terug op de statische lijst van de frontend (dezelfde val als
 * op de kaart: liever "Drive" dan "google-drive"), en een app die deze
 * gebruiker niet mag blijft ZICHTBAAR — hij kan voor een ander wél werken,
 * want de agent draait standaard in naam van de vrager. Een app die deze
 * INSTALLATIE niet heeft blijft om dezelfde reden staan: hem verzwijgen is de
 * enige lezing die noch "afwezig" noch "niet toegekend" is, en dan valt er ook
 * niets over uit te vinken.
 */
function namedApps(apps, labels, t) {
    if (!Array.isArray(apps)) return [];
    // Eén rij per grant-subject: twee entries over dezelfde module (Outlook en
    // Outlook read-only) leveren dezelfde tools, en de runtime laat ze allebei
    // meebeslissen. Twee losse rijen lieten één vinkje ERBIJ er stil twee AF
    // nemen op de rij ernaast. Zie `foldSharedApps`.
    apps = foldSharedApps(apps);
    const labelOf = (id) => {
        if (labels instanceof Map) return labels.get(id) || null;
        if (labels && typeof labels === 'object' && typeof labels[id] === 'string') return labels[id];
        return null;
    };
    return apps
        .filter(app => app && typeof app.id === 'string' && app.id)
        .map(app => ({
            ...app,
            label: app.label || labelOf(app.id) || app.id,
            unavailableHint: unavailableHintFor(t, app) || undefined,
        }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

/**
 * Eén app in de gefaseerde selectie aanpassen.
 *
 * Een app waarvan de acties ONBEKEND zijn (`null`) blijft onaangeraakt: je kunt
 * niet kiezen wat je niet kunt zien, en er per ongeluk een lege verzameling van
 * maken zou een weigering opslaan die niemand uitsprak.
 */
function withPicked(prev, appId, mutate) {
    if (!(prev instanceof Map)) return prev;
    const current = prev.get(appId);
    if (!(current instanceof Set)) return prev;
    const picked = new Set(current);
    mutate(picked);
    const next = new Map(prev);
    next.set(appId, picked);
    return next;
}

/**
 * De teksten van de gedeelde schil, vertaald.
 *
 * De schil zelf kent geen `t()` — hij wordt ook gerenderd door twee surfaces
 * die er geen hebben. Wie hem wél heeft, geeft ze hier mee; de Engelse
 * standaarden in `PICKER_TEXT` blijven de terugval.
 */
function chooserText(t) {
    return {
        search: t('agent_studio.can_use.chooser_search', 'Search apps and actions'),
        enableAll: t('agent_studio.can_use.chooser_enable_all', 'Switch all on'),
        disableAll: t('agent_studio.can_use.chooser_disable_all', 'Switch all off'),
        selectedOf: t('agent_studio.can_use.chooser_selected_of_plural', '{selected} of {total} actions on'),
        selectedOfOne: t('agent_studio.can_use.chooser_selected_of', '{selected} of {total} action on'),
        noMatch: t('agent_studio.can_use.chooser_no_match', 'No actions match this filter.'),
        actionsUnknown: t('agent_studio.can_use.chooser_actions_unknown', 'Could not read this app’s actions, so there is nothing to choose here.'),
        filterAll: t('agent_studio.can_use.filter_all', 'All'),
        filterReads: t('agent_studio.can_use.filter_reads', 'Reads'),
        filterWrites: t('agent_studio.can_use.filter_writes', 'Writes'),
        filterSends: t('agent_studio.can_use.filter_sends', 'Sends'),
        filterGroup: t('agent_studio.can_use.filter_group', 'Filter actions by what they do'),
        badgeReads: t('agent_studio.can_use.effect_reads', 'reads'),
        badgeWrites: t('agent_studio.can_use.effect_writes', 'writes'),
        badgeSends: t('agent_studio.can_use.effect_sends', 'sends'),
        badgeUnknown: t('agent_studio.can_use.effect_unknown', 'unknown'),
        badgeList: t('agent_studio.can_use.effect_list', 'list'),
        sendsNote: t('agent_studio.can_use.sends_always_confirmed', 'always confirmed first'),
    };
}

/** De twee toestanden die geen kiezer opleveren: nog bezig, of niet gelukt. */
function ChooserNotice({ t, kind, onRetry, onClose }) {
    const message = kind === READ.LOADING
        ? t('agent_studio.can_use.chooser_loading', 'Loading your apps…')
        : t('agent_studio.can_use.chooser_unreadable', 'Could not load the app list, so there is nothing to choose from right now.');
    return (
        <Modal
            open
            onClose={onClose}
            size="md"
            label={t('agent_studio.can_use.chooser_title', 'Choose apps & actions')}
            data-testid="agent-tool-chooser-notice"
        >
            <p className="text-sm text-[var(--text-primary)]" style={kind === READ.ERROR ? { color: 'var(--warning)' } : undefined}>
                {message}
            </p>
            <div className="mt-4 flex items-center gap-2">
                {kind === READ.ERROR && onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        data-testid="agent-tool-chooser-retry"
                        className="rounded-md border border-[var(--border-default)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-primary)]"
                    >
                        {t('agent_studio.retry', 'Retry')}
                    </button>
                )}
                <button type="button" onClick={onClose} className="rounded-md px-2.5 py-1.5 text-xs text-[var(--text-secondary)]">
                    {t('agent_studio.close', 'Close')}
                </button>
            </div>
        </Modal>
    );
}

/** De voet: wat er verandert, waarschuwing bij de eerste curatie, en toepassen. */
function ChooserFooter({ t, ro, delta, degraded, firstCuration, onApply }) {
    // Alleen-lezen: de kiezer TOONT wat er aanstaat, maar biedt geen knop die
    // een opslag start die de server toch weigert. De vinkjes zelf staan uit
    // via `readOnly` op de schil, dus er valt hier ook niets te tellen.
    if (ro) {
        return (
            <p className="text-[12px]" style={{ color: 'var(--text-tertiary)' }} data-testid="agent-tool-chooser-readonly">
                {t('agent_studio.can_use.chooser_read_only', 'Read-only — you cannot change what this agent may use.')}
            </p>
        );
    }
    const label = delta.added > 0 && delta.removed === 0
        ? nOf(t, 'agent_studio.can_use.chooser_add', delta.added, 'Add {count} tool', 'Add {count} tools')
        : delta.removed > 0 && delta.added === 0
            ? nOf(t, 'agent_studio.can_use.chooser_remove', delta.removed, 'Remove {count} tool', 'Remove {count} tools')
            : delta.dirty
                ? t('agent_studio.can_use.chooser_apply', 'Apply changes')
                : t('agent_studio.can_use.chooser_nothing', 'Nothing to change');

    return (
        <div className="flex flex-col gap-2">
            {degraded && (
                <p className="text-[11px]" style={{ color: 'var(--warning)' }} data-testid="agent-tool-chooser-degraded">
                    {t('agent_studio.can_use.tools_degraded', 'Could not check which apps you are allowed to use, so nothing is claimed about that here.')}
                </p>
            )}
            {firstCuration && (
                <p className="text-[11px]" style={{ color: 'var(--warning)' }} data-testid="agent-tool-chooser-first-curation">
                    {t('agent_studio.can_use.chooser_first_curation', 'This is the first time you limit this agent: from now on it gets only what is ticked here, and actions that send always ask a person first.')}
                </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
                <button
                    type="button"
                    onClick={onApply}
                    disabled={!delta.dirty}
                    data-testid="agent-tool-chooser-apply"
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                    style={{ background: 'var(--accent-primary)' }}
                >
                    {label}
                </button>
                <span className="text-xs text-[var(--text-tertiary)]">
                    {delta.added > 0 && delta.removed > 0 ? (
                        <>
                            <span>{nOf(t, 'agent_studio.can_use.chooser_delta_added', delta.added, '{count} action added', '{count} actions added')}</span>
                            <span aria-hidden="true"> · </span>
                            <span>{nOf(t, 'agent_studio.can_use.chooser_delta_removed', delta.removed, '{count} action removed', '{count} actions removed')}</span>
                        </>
                    ) : t('agent_studio.can_use.chooser_hint', 'Tick what this agent may do. Unticking everything switches the app off.')}
                </span>
            </div>
        </div>
    );
}

export default function ToolChooser({
    t,
    ro = false,
    open = false,
    focusAppId = null,
    apps = null,
    catalogState = READ.OK,
    catalogDegraded = false,
    onRetryCatalog,
    labels = null,
    toolsConfig = null,
    enabledIntegrations = null,
    onCommit,
    onClose,
}) {
    const shownApps = useMemo(() => namedApps(apps, labels, t), [apps, labels, t]);

    const [initial, setInitial] = useState(null);
    const [selection, setSelection] = useState(null);

    // Opnieuw beginnen zodra de kiezer OPENT of er ANDERE apps zijn.
    //
    // De afhankelijkheid is bewust de LIJST APP-IDS en niet het apps-object:
    // de editor tekent opnieuw bij van alles wat niets met de kiezer te maken
    // heeft (opslagstatus, een binnenkomende lezing, een relatieve tijd) en
    // geeft dan een vers array door. Op de identiteit afgaan betekent dus dat
    // de kiezer middenin het vinken opnieuw van de config uitgaat en weggooit
    // waar iemand mee bezig is — een verlies dat je pas merkt bij "toepassen".
    //
    // `toolsConfig` staat er om dezelfde reden NIET in: die verandert door onze
    // eigen opslag.
    const appsKey = useMemo(() => shownApps.map(app => app.id).join('|'), [shownApps]);
    const seedSelection = useEffectEvent(() => {
        if (!open || !Array.isArray(apps)) { setInitial(null); setSelection(null); return; }
        const start = chooserInitialSelection({
            toolsConfig, enabledIntegrations, apps: shownApps, catalog: apps,
        });
        setInitial(start);
        setSelection(new Map(start));
    });
    useEffect(() => { seedSelection(); }, [open, appsKey]);

    const delta = useMemo(
        () => (initial && selection ? selectionDelta(initial, selection) : { added: 0, removed: 0, dirty: false }),
        [initial, selection],
    );

    if (!open) return null;
    if (catalogState === READ.LOADING) return <ChooserNotice t={t} kind={READ.LOADING} onClose={onClose} />;
    if (catalogState === READ.ERROR || !Array.isArray(apps)) {
        return <ChooserNotice t={t} kind={READ.ERROR} onRetry={onRetryCatalog} onClose={onClose} />;
    }

    const toggle = (name, app) => setSelection(prev => withPicked(prev, app.id, picked => {
        if (picked.has(name)) picked.delete(name); else picked.add(name);
    }));

    // "Alles aan/uit" werkt op de ZICHTBARE acties (de schil geeft ze mee), zodat
    // een actief filter niet stilletjes ook de verborgen rijen omzet.
    const toggleApp = (app, on, visibleActions) => setSelection(prev => withPicked(prev, app.id, (picked) => {
        for (const action of visibleActions || app.actions || []) {
            if (!action || !action.name) continue;
            if (on) picked.add(action.name); else picked.delete(action.name);
        }
    }));

    const apply = () => {
        const out = commitSelection({
            toolsConfig, enabledIntegrations, apps: shownApps, catalog: apps, initial, selection,
        });
        onCommit?.(out);
        onClose?.();
    };

    return (
        <AppActionPicker
            apps={shownApps}
            selection={selection || new Map()}
            onToggle={toggle}
            onToggleApp={toggleApp}
            onClose={onClose}
            focusAppId={focusAppId}
            readOnly={ro}
            title={t('agent_studio.can_use.chooser_title', 'Choose apps & actions')}
            emptyLabel={t('agent_studio.can_use.chooser_empty', 'No apps available for you yet')}
            unavailableHint={t('agent_studio.can_use.chooser_unavailable_hint', 'not connected for you — someone else asking this agent may still have it')}
            text={chooserText(t)}
            footer={(
                <ChooserFooter
                    t={t}
                    ro={ro}
                    delta={delta}
                    degraded={catalogDegraded}
                    firstCuration={delta.dirty && !hasCuratedGrants(toolsConfig)}
                    onApply={apply}
                />
            )}
        />
    );
}
