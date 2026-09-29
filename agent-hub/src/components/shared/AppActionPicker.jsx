import { Check, Search, X } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import Modal from './Modal';
import { getIntegrationIcon } from '../../config/integrationIcons';

/**
 * The app menu, shared.
 *
 * One overlay — search + app list on the left, the focused app's ACTIONS on the
 * right — used by every surface that asks "which app, and which of its actions?".
 * It was the agent editor's AppsPicker, then the AI step's ToolPicker grew an
 * actions pane on top of a copy of it, and App Studio connectors had neither
 * (two bare <select>s). Three surfaces, three answers to the same question. This
 * is the one shell all of them render, so an improvement to the app menu lands
 * everywhere at once.
 *
 * Presentational only: no fetching, no catalog knowledge. Callers pass apps
 * already permission-gated by the server and own the selection.
 *
 * Props
 *   apps        [{ id, label, description?, available?, unavailableHint?,
 *                 actionsKnown?, actions:
 *                 [{ name, label, description?, effect?, sideEffect?,
 *                    producesList? }] }]
 *   selected    string[] of selected action names            (PLATTE model)
 *   selection   Map|object appId → Set|Array|null            (PER-APP model)
 *   onToggle    (actionName, app, action) => void
 *   onToggleApp (app, turnOn, visibleActions) => void  — optional "Enable/Disable all"
 *   onClose     () => void
 *   title       heading above the search box
 *   emptyLabel  what to say when there are no apps at all
 *   footer      optional node pinned under the action list (e.g. an Apply bar)
 *   unavailableHint  what "not connected" means on this surface. An app may
 *                    carry its own `unavailableHint` and it WINS: an app that
 *                    the installation does not have is a different fact from
 *                    one the caller never connected, and only the app knows
 *                    which of the two it is.
 *   focusAppId  open with this app's actions in view
 *   readOnly    show the selection but refuse every change (a viewer without
 *               edit rights sees WHAT is on; the buttons say they are not his)
 *   text        overrides for the shell's own English strings (so a translated
 *               surface can hand them in; see PICKER_TEXT)
 *
 * `available: false` apps stay VISIBLE and pickable but are labelled — hiding
 * them is what makes a picker feel broken ("where is Gmail?"), and on some
 * surfaces (a connector set to run as each viewer) an app the author hasn't
 * connected is a legitimate choice.
 *
 * ── TWEE SELECTIEMODELLEN, EN WAAROM ────────────────────────────────
 * `selected` is een PLATTE lijst actienamen. Die vorm kan "over deze app is
 * niets gezegd" en "deze app mag niets" NIET uit elkaar houden — en precies dat
 * verschil is waar de agent-grants op draaien (een app die de map niet noemt
 * houdt zijn hele toolbelt; zie `AgentWizard/canUse/toolGrants.js`). Daarom kan
 * een aanroeper in plaats daarvan `selection` meegeven: per app een eigen
 * verzameling, met drie toestanden.
 *
 *   Set(...)     deze acties staan aan (een LEGE set is een echte keuze: niets);
 *   ontbrekend   over deze app is niets gezegd — de schil vinkt niets aan;
 *   null         de acties van deze app zijn ONBEKEND (de module laadde niet).
 *                Er valt dan niets te vinken, en de schil biedt het ook niet
 *                aan: een leeg lijstje tonen zou "deze app heeft geen acties"
 *                beweren.
 *
 * De twee bestaande consumenten (de AI-stap en de App Studio-connectorkiezer)
 * blijven de platte vorm gebruiken; die kent het onderscheid niet en heeft het
 * ook niet nodig — daar IS een niet-aangevinkte tool gewoon niet gekozen.
 *
 * ── DE EFFECT-CHIPS ─────────────────────────────────────────────────
 * Zodra de catalogus `effect` draagt (`reads`/`writes`/`sends`) verschijnen de
 * filterchips en de effect-badges. Draagt hij dat niet, dan verandert er niets:
 * chips die filteren op een veld dat er niet is, verbergen alles.
 *
 * Een actie met een ONBEKEND effect valt onder "Sends". Dat is dezelfde smalle
 * lezing die de runtime neemt (`sendsFor`, `normaliseToolsConfig`): we weten
 * niet wat hij doet, dus hij kan versturen — en de rij die je onder "Verstuurt"
 * zoekt is precies de rij die je niet wilt missen.
 */

/** De Engelse standaardteksten van de schil. Een surface met `t()` overschrijft ze. */
export const PICKER_TEXT = Object.freeze({
    search: 'Search apps and actions',
    enableAll: 'Enable all',
    disableAll: 'Disable all',
    // Enkelvoud en meervoud als twee STRINGS, niet als een ternary om het woord
    // heen: de schil kiest de hele zin, en een surface met `t()` hangt er twee
    // sleutels aan (basis + `_plural`, de conventie van dit product).
    selectedOf: '{selected} of {total} actions selected',
    selectedOfOne: '{selected} of {total} action selected',
    noMatch: 'This app has no matching actions.',
    actionsUnknown: 'Could not read this app’s actions, so there is nothing to tick here.',
    filterAll: 'All',
    filterReads: 'Reads',
    filterWrites: 'Writes',
    filterSends: 'Sends',
    filterGroup: 'Filter actions by what they do',
    badgeReads: 'reads',
    badgeWrites: 'writes',
    badgeSends: 'sends',
    badgeUnknown: 'unknown',
    badgeList: 'list',
    // BEWUST LEEG. "Wordt altijd eerst bevestigd" is een regel van de
    // AGENT-runtime (`confirmForTool` zegt bij een send altijd `ask`); een
    // routine-stap kent die regel niet — daar staat één bevestiging vóór de
    // eerste onbeheerde run. Een schil die de zin standaard toont, zou hem dus
    // op één van zijn twee oppervlakken verzinnen. Wie de regel wél heeft,
    // geeft de tekst mee.
    sendsNote: null,
});

const EFFECTS = Object.freeze(['reads', 'writes', 'sends']);

/** `reads`/`writes`/`sends`, of `null` als de catalogus het niet zegt. */
export function actionEffect(action) {
    const raw = action && typeof action.effect === 'string' ? action.effect.trim() : '';
    return EFFECTS.includes(raw) ? raw : null;
}

/** Onbekend telt als versturen — dezelfde lezing als de runtime. */
function matchesEffectFilter(action, filter) {
    if (filter === 'all') return true;
    const effect = actionEffect(action);
    if (effect === null) return filter === 'sends';
    return effect === filter;
}

/** De token-kleur van een effect. Geen losse hexwaarden: het thema beslist. */
const EFFECT_TOKEN = Object.freeze({
    reads: 'var(--success)',
    writes: 'var(--warning)',
    sends: 'var(--error)',
    unknown: 'var(--error)',
});

function fmt(template, vars) {
    let out = String(template ?? '');
    for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
    return out;
}

/** Een badge in één token — tekst én rand in dezelfde kleur. */
function EffectBadge({ kind, label }) {
    return (
        <span
            data-testid={`action-effect-${kind}`}
            className="text-[9px] uppercase tracking-wide font-semibold border rounded px-1 py-px flex-shrink-0"
            style={{ color: EFFECT_TOKEN[kind], borderColor: EFFECT_TOKEN[kind] }}
        >
            {label}
        </span>
    );
}

/** De chiprij. Verschijnt alleen als er effecten in de catalogus staan. */
function EffectFilters({ txt, value, onChange }) {
    const chips = [
        ['all', txt.filterAll],
        ['reads', txt.filterReads],
        ['writes', txt.filterWrites],
        ['sends', txt.filterSends],
    ];
    return (
        <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={txt.filterGroup}>
            {chips.map(([key, label]) => (
                <button
                    key={key}
                    type="button"
                    data-testid={`action-filter-${key}`}
                    aria-pressed={value === key}
                    onClick={() => onChange(key)}
                    className={`h-6 px-2.5 rounded-full text-[11px] border transition ${value === key
                        ? 'border-[var(--accent)] text-[var(--accent)]'
                        : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
                >
                    {label}
                </button>
            ))}
        </div>
    );
}

/** Eén actierij. Een rij die kán versturen dimt en zegt dat er eerst gevraagd wordt. */
function ActionRow({ action, app, on, readOnly, showEffect, txt, onToggle }) {
    const effect = actionEffect(action);
    const sendsIsh = showEffect && (effect === 'sends' || effect === null);
    return (
        <button
            type="button"
            aria-pressed={on}
            disabled={readOnly}
            onClick={() => onToggle?.(action.name, app, action)}
            style={sendsIsh ? { opacity: 0.7 } : undefined}
            data-testid={sendsIsh ? 'action-row-sends' : 'action-row'}
            className="w-full flex items-start gap-3 px-3 py-2 rounded-lg text-left hover:bg-[var(--bg-secondary)] transition disabled:cursor-not-allowed"
        >
            <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${on ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[var(--border-default)]'}`}>
                {on && <Check size={12} className="text-[var(--bg-primary)]" />}
            </span>
            <span className="flex-1 min-w-0">
                <span className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm text-[var(--text-primary)] truncate">{action.label || action.name}</span>
                    {/* A list action is the one that can fill a table — worth
                        seeing before you pick, not after. */}
                    {action.producesList && (
                        <span className="text-[9px] uppercase tracking-wide font-semibold text-[var(--accent)] border border-[var(--accent)]/50 rounded px-1 py-px flex-shrink-0">{txt.badgeList}</span>
                    )}
                    {showEffect
                        ? <EffectBadge kind={effect || 'unknown'} label={effect ? txt[`badge${effect[0].toUpperCase()}${effect.slice(1)}`] : txt.badgeUnknown} />
                        : action.sideEffect && <EffectBadge kind="writes" label={txt.badgeWrites} />}
                    {sendsIsh && txt.sendsNote && (
                        <span className="text-[10px] text-[var(--text-tertiary)] flex-shrink-0">{txt.sendsNote}</span>
                    )}
                </span>
                {action.description && (
                    <span className="block text-xs text-[var(--text-tertiary)] mt-0.5 line-clamp-2">{action.description}</span>
                )}
            </span>
        </button>
    );
}

export default function AppActionPicker({
    apps = [],
    selected = [],
    selection = null,
    onToggle,
    onToggleApp,
    onClose,
    title = 'Choose apps & actions',
    emptyLabel = 'No apps available',
    footer = null,
    unavailableHint = 'not connected',
    focusAppId = null,
    readOnly = false,
    text = null,
}) {
    const txt = useMemo(() => ({ ...PICKER_TEXT, ...(text || {}) }), [text]);
    const flatSet = useMemo(() => new Set(selected), [selected]);
    const [search, setSearch] = useState('');
    const [effectFilter, setEffectFilter] = useState('all');
    const [focusedId, setFocusedId] = useState(focusAppId || apps[0]?.id || null);

    // Het per-app model wint van het platte. `undefined` = niets gezegd (geen
    // vinkjes), `null` = onbekend (niets te vinken, en dus ook niets aan te
    // raken). Zie de kop.
    const pickedFor = (appId) => {
        if (!selection) return undefined;
        const raw = selection instanceof Map ? selection.get(appId) : selection[appId];
        if (raw === null) return null;
        if (raw === undefined) return undefined;
        return raw instanceof Set ? raw : new Set(Array.isArray(raw) ? raw : []);
    };
    const isOn = (appId, name) => {
        if (!selection) return flatSet.has(name);
        const picked = pickedFor(appId);
        return picked instanceof Set ? picked.has(name) : false;
    };
    const countFor = (app) => (app.actions || []).reduce((n, a) => n + (isOn(app.id, a.name) ? 1 : 0), 0);

    // Draagt deze catalogus effecten? Zo niet: geen chips, geen effect-badges
    // — filteren op een veld dat er niet is verbergt alles.
    const showEffect = useMemo(
        () => apps.some(app => (app.actions || []).some(a => actionEffect(a))),
        [apps],
    );

    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q) return apps;
        return apps.filter((app) =>
            (app.label || app.id || '').toLowerCase().includes(q)
            || (app.actions || []).some((a) =>
                (a.label || '').toLowerCase().includes(q)
                || (a.name || '').toLowerCase().includes(q)
                || (a.description || '').toLowerCase().includes(q)),
        );
    }, [apps, search]);

    useEffect(() => {
        if (filtered.length && !filtered.some((app) => app.id === focusedId)) {
            setFocusedId(filtered[0].id);
        }
    }, [filtered, focusedId]);

    // De ↗ op een tool-rij opent de kiezer op DIE app; verandert het verzoek,
    // dan verspringt de focus mee.
    useEffect(() => {
        if (focusAppId && apps.some((app) => app.id === focusAppId)) setFocusedId(focusAppId);
    }, [focusAppId, apps]);

    const focused = apps.find((app) => app.id === focusedId) || filtered[0] || null;
    // When a search is active the right pane shows only the matching actions —
    // searching "attachment" should not make you hunt through 15 Gmail actions.
    const q = search.trim().toLowerCase();
    const focusedActions = useMemo(() => {
        const all = focused?.actions || [];
        const byEffect = all.filter((a) => matchesEffectFilter(a, effectFilter));
        if (!q) return byEffect;
        const appMatches = (focused?.label || '').toLowerCase().includes(q);
        const hits = byEffect.filter((a) => (a.label || '').toLowerCase().includes(q)
            || (a.name || '').toLowerCase().includes(q)
            || (a.description || '').toLowerCase().includes(q));
        return hits.length ? hits : (appMatches ? byEffect : hits);
    }, [focused, q, effectFilter]);

    // Een app waarvan de acties onbekend zijn: niets te vinken, en de schil
    // biedt het ook niet aan.
    const focusedUnknown = !!focused && (focused.actionsKnown === false || pickedFor(focused.id) === null);
    const selectedCount = focusedActions.filter((a) => isOn(focused?.id, a.name)).length;
    const allOn = focusedActions.length > 0 && selectedCount === focusedActions.length;

    return (
        <Modal
            open
            onClose={() => onClose?.()}
            variant="bare"
            size="auto"
            label={title}
            className="max-w-3xl h-[560px] rounded-2xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] shadow-2xl overflow-hidden"
        >
            <div className="flex-1 min-h-0 flex">
                {/* Left: search + app list */}
                <div className="w-[40%] flex flex-col border-r border-[var(--border-default)]">
                    <div className="p-3">
                        <div className="relative">
                            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" />
                            <input
                                type="text"
                                value={search}
                                onChange={(e) => setSearch(e.target.value)}
                                placeholder={txt.search}
                                aria-label={txt.search}
                                className="w-full bg-[var(--bg-secondary)] rounded-full pl-9 pr-3 py-2 text-sm outline-none text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                                autoFocus
                            />
                        </div>
                    </div>
                    <div className="flex-1 overflow-y-auto px-2 pb-2">
                        {filtered.length === 0 && (
                            <div className="text-xs text-[var(--text-tertiary)] text-center py-6">{emptyLabel}</div>
                        )}
                        {filtered.map((app) => {
                            const isFocus = app.id === focusedId;
                            const count = countFor(app);
                            return (
                                <button
                                    key={app.id}
                                    type="button"
                                    onClick={() => setFocusedId(app.id)}
                                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm transition ${isFocus ? 'bg-[var(--bg-secondary)]' : 'hover:bg-[var(--bg-secondary)]/60'}`}
                                >
                                    <div className="w-6 h-6 flex items-center justify-center flex-shrink-0">{getIntegrationIcon(app.id)}</div>
                                    <span className={`truncate flex-1 ${app.available === false ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
                                        {app.label || app.id}
                                    </span>
                                    {count > 0 && (
                                        <span
                                            className="text-[10px] font-semibold text-[var(--bg-primary)] bg-[var(--accent)] rounded-full min-w-[18px] h-[18px] px-1 flex items-center justify-center"
                                            aria-label={`${count} selected`}
                                        >
                                            {count}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </div>

                {/* Right: the focused app's actions */}
                <div className="flex-1 flex flex-col relative min-w-0">
                    <button
                        onClick={onClose}
                        className="absolute top-3 right-3 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] z-10"
                        aria-label="Close"
                    >
                        <X size={18} />
                    </button>
                    {focused ? (
                        <>
                            <div className="px-6 pt-6 pb-3 border-b border-[var(--border-default)]">
                                <div className="flex items-center gap-3 mb-1">
                                    <div className="w-9 h-9 rounded-xl border border-[var(--border-default)] flex items-center justify-center flex-shrink-0">
                                        <div className="w-5 h-5 flex items-center justify-center">{getIntegrationIcon(focused.id)}</div>
                                    </div>
                                    <h3 className="text-lg font-semibold text-[var(--text-primary)] flex-1 truncate">{focused.label || focused.id}</h3>
                                    {onToggleApp && !readOnly && focusedActions.length > 0 && !focusedUnknown && (
                                        <button
                                            type="button"
                                            onClick={() => onToggleApp(focused, !allOn, focusedActions)}
                                            className="text-xs font-medium text-[var(--accent)] hover:underline whitespace-nowrap"
                                        >
                                            {allOn ? txt.disableAll : txt.enableAll}
                                        </button>
                                    )}
                                </div>
                                <p className="text-xs text-[var(--text-tertiary)]">
                                    {fmt(
                                        focusedActions.length === 1 ? txt.selectedOfOne : txt.selectedOf,
                                        { selected: selectedCount, total: focusedActions.length },
                                    )}
                                </p>
                                {showEffect && (
                                    <div className="mt-2">
                                        <EffectFilters txt={txt} value={effectFilter} onChange={setEffectFilter} />
                                    </div>
                                )}
                                {focused.available === false && (
                                    <p className="mt-2 text-xs rounded-md border px-2 py-1.5"
                                        style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
                                        role="alert"
                                    >
                                        {/* Per-app first: "this server has no browser" is not the
                                            same sentence as "you have not connected it", and the
                                            surface-wide hint can only say one of the two. */}
                                        {focused.label || focused.id} is {focused.unavailableHint || unavailableHint}.
                                    </p>
                                )}
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
                                {focusedUnknown && (
                                    <div data-testid="app-actions-unknown" className="text-xs text-center py-6" style={{ color: 'var(--warning)' }}>
                                        {txt.actionsUnknown}
                                    </div>
                                )}
                                {!focusedUnknown && focusedActions.length === 0 && (
                                    <div className="text-xs text-[var(--text-tertiary)] text-center py-6">{txt.noMatch}</div>
                                )}
                                {!focusedUnknown && focusedActions.map((action) => (
                                    <ActionRow
                                        key={action.name}
                                        action={action}
                                        app={focused}
                                        on={isOn(focused.id, action.name)}
                                        readOnly={readOnly}
                                        showEffect={showEffect}
                                        txt={txt}
                                        onToggle={onToggle}
                                    />
                                ))}
                            </div>
                            {footer ? (
                                <div className="border-t border-[var(--border-default)] px-4 py-3">{footer}</div>
                            ) : null}
                        </>
                    ) : (
                        <div className="flex-1 flex items-center justify-center text-sm text-[var(--text-tertiary)]">{emptyLabel}</div>
                    )}
                </div>
            </div>
        </Modal>
    );
}
