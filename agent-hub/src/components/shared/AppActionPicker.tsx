import { Check, Search, X } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import Modal from './Modal';
import { getIntegrationIcon } from '../../config/integrationIcons';
import useTranslation from '../../hooks/useTranslation';
import type { ToolApp } from '../agents/AgentWizard/canUse/toolCatalogTypes';
import type { PickerAction, PickerApp, PickerText, EffectBadgeProps, EffectFiltersProps, ActionRowProps, AppActionPickerProps } from './AppActionPicker.types';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';

/** De Engelse standaardteksten van de schil. Een surface met `t()` overschrijft ze. */
const PICKER_TEXT = Object.freeze({
    search: 'Search apps and actions',
    enableAll: 'Enable all',
    disableAll: 'Disable all',
    // Singular and plural as two STRINGS, not as a ternary around the word. The shell
    // chooses the whole sentence, and a surface with `t()` attaches two keys to it
    // (base + `_plural`, the convention of this product).
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
    // DELIBERATELY EMPTY. "Always confirmed first" is a rule of the AGENT runtime
    // (`confirmForTool` always says `ask` for a send). An automation step does not
    // know that rule. There, one confirmation sits before the first unattended run.
    // A shell that showed the sentence by default would therefore invent it on one of
    // its two surfaces. Whoever has the rule supplies the text.
    sendsNote: null,
});

const EFFECTS = Object.freeze(['reads', 'writes', 'sends']);

/** `reads`/`writes`/`sends`, or `null` if the catalogue does not say so. */
function actionEffect(action: PickerAction) {
    const raw = action && typeof action.effect === 'string' ? action.effect.trim() : '';
    return EFFECTS.includes(raw) ? raw : null;
}

/** Onbekend telt als versturen — dezelfde lezing als de runtime. */
function matchesEffectFilter(action: PickerAction, filter: string) {
    if (filter === 'all') return true;
    const effect = actionEffect(action);
    if (effect === null) return filter === 'sends';
    return effect === filter;
}

/** The token color of an effect. No loose hex values: the theme decides. */
const EFFECT_TOKEN: Readonly<Record<string, string>> = Object.freeze({
    reads: 'var(--success)',
    writes: 'var(--warning)',
    sends: 'var(--error)',
    unknown: 'var(--error)',
});

function fmt(template: string, vars: { selected: number; total: number }) {
    let out = String(template ?? '');
    for (const [k, v] of Object.entries(vars || {})) out = out.split(`{${k}}`).join(String(v));
    return out;
}

function EffectBadge({ kind, label }: EffectBadgeProps) {
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

function EffectFilters({ txt, value, onChange }: EffectFiltersProps) {
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

function ActionRow({ action, app, on, readOnly, showEffect, txt, onToggle }: ActionRowProps) {
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
                        ? <EffectBadge kind={effect || 'unknown'} label={effect ? txt[`badge${effect[0].toUpperCase()}${effect.slice(1)}`] as string : txt.badgeUnknown} />
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
}: AppActionPickerProps) {
    const { t } = useTranslation();
    const txt = useMemo<PickerText>(() => ({ ...PICKER_TEXT, ...(text || {}) }), [text]);
    const flatSet = useMemo(() => new Set<string | undefined>(selected), [selected]);
    const [search, setSearch] = useState('');
    const [effectFilter, setEffectFilter] = useState('all');
    const [focusedId, setFocusedId] = useState(focusAppId || apps[0]?.id || null);

    // The per-app model wins over the flat one. `undefined` means nothing was said (no
    // ticks), `null` means unknown (nothing to tick, and therefore nothing to touch).
    // See the heading.
    const pickedFor = (appId: string | undefined): Set<string | undefined> | null | undefined => {
        if (!selection) return undefined;
        const raw = selection instanceof Map ? selection.get(appId as string) : selection[appId as string];
        if (raw === null) return null;
        if (raw === undefined) return undefined;
        return raw instanceof Set ? raw : new Set(Array.isArray(raw) ? raw : []);
    };
    const isOn = (appId: string | undefined, name: string | undefined) => {
        if (!selection) return flatSet.has(name);
        const picked = pickedFor(appId);
        return picked instanceof Set ? picked.has(name) : false;
    };
    const countFor = (app: PickerApp) => (app.actions || []).reduce((n, a) => n + (isOn(app.id, a.name) ? 1 : 0), 0);

    // Does this catalogue carry effects? If not, there are no chips and no effect
    // badges. Filtering on a field that is not there hides everything.
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

    if (filtered.length && !filtered.some((app) => app.id === focusedId)) {
        setFocusedId(filtered[0].id);
    }

    // The ↗ on a tool row opens the picker on THAT app. If the request changes, the
    // focus moves along with it.
    useAdjustOnChange([focusAppId, apps], () => {
        if (focusAppId && apps.some((app) => app.id === focusAppId)) setFocusedId(focusAppId);
    });

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

    // An app whose actions are unknown: nothing to tick, and the shell does not offer
    // it either.
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
                <AppActionPickerSection search={search} setSearch={setSearch} txt={txt} filtered={filtered} emptyLabel={emptyLabel} focusedId={focusedId} countFor={countFor} setFocusedId={setFocusedId} />

                {/* Right: the focused app's actions */}
                <div className="flex-1 flex flex-col relative min-w-0">
                    <button
                        onClick={onClose}
                        className="absolute top-3 right-3 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] z-10"
                        aria-label={t('common.close', 'Close')}
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
                                    <p className="mt-2 text-xs rounded-md border px-2 py-1.5 border-[var(--warning)] text-[var(--warning)]"
                                        role="alert"
                                    >
                                        {/* Per-app first: "this server has no browser" is not the
                                            same sentence as "you have not connected it", and the
                                            surface-wide hint can only say one of the two. */}
                                        {t('common.app_action_unavailable', '{name} is {hint}.', { name: focused.label || focused.id, hint: focused.unavailableHint || unavailableHint })}
                                    </p>
                                )}
                            </div>
                            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
                                {focusedUnknown && (
                                    <div data-testid="app-actions-unknown" className="text-xs text-center py-6 text-[var(--warning)]">
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

function AppActionPickerSection({ search, setSearch, txt, filtered, emptyLabel, focusedId, countFor, setFocusedId }: { search: string; setSearch: React.Dispatch<React.SetStateAction<string>>; txt: PickerText; filtered: PickerApp[]; emptyLabel: string; focusedId: string | null; countFor: (app: PickerApp) => number; setFocusedId: React.Dispatch<React.SetStateAction<string | null>>; }) {
    return <div className="w-[40%] flex flex-col border-r border-[var(--border-default)]">
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
                    autoFocus />
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
    </div>;
}
