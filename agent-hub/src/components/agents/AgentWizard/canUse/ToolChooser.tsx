import React, { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { READ } from './canUseFacts';
import { chooserInitialSelection, commitSelection, foldSharedApps, selectionDelta } from './toolChooserModel';
import { type SelectionMap, type ToolsConfig } from './toolGrants';
import { hasCuratedGrants } from './toolGrants.helpers';
import { nOf } from '../../../admin/Studio/KnowledgeStudio/plural';
import AppActionPicker from '../../../shared/AppActionPicker';
import Modal from '../../../shared/Modal';
import type { ToolApp } from './toolCatalogTypes';
import type { TranslateParams } from '../../../../hooks/useTranslation';

/**
 * The TOOL PICKER of the agent editor (Agents artboard 1f, A2 step 4).
 *
 * The shell is `shared/AppActionPicker`, the same overlay as the AI step of the automations builder and the
 * connector picker of App Studio. So no third picker is added next to the two that already exist. What this
 * file adds is the BINDING: which selection goes in, what comes out on apply, and the sentences around it.
 *
 * ── WHY THIS DOES NOT USE THE FLAT `selected` ───────────────────────
 * Until this stage the shell knew one selection model: a flat list of action names. That shape cannot tell
 * "nothing has been said about this app" apart from "this app may do nothing". That is exactly the difference
 * the agent grants rest on (finding 1 of the A1b rights-layer review: the empty section was thrown away and
 * then read as "never chosen", so ALL automations were allowed again). That is why this picker takes a
 * `selection` Map: per app its own set, with an empty set as a real choice.
 *
 * ── ONE SAVE PER SESSION ────────────────────────────────────────────
 * Each tick mutates only local state. Only on "apply" does one `patchConfig` leave, with the grants map and the
 * app-level list in it. That is not only more economical: an agent that gets saved after every tick while you
 * are choosing is halfway through a thought in production.
 *
 * ── WHAT THE PICKER SAYS OUT LOUD ───────────────────────────────────
 * The first entry in the grants map puts the agent into the confirmation regime (`hasCuratedGrants` in
 * toolPolicy.js: before that, the runtime does not even look at the map). For an agent that today runs a mail
 * routine unattended, that is a noticeable change in behaviour behind one click. So it is stated in the footer,
 * before saving, and not in a release note afterwards.
 *
 * ── A FAILED CATALOGUE IS NOT AN EMPTY PICKER ───────────────────────
 * Without a catalogue there are no actions to choose from. An empty overlay would then claim "you have no apps".
 * This one says that the list could not be read and offers to try again. That is precisely the opposite of the
 * Tools CARD, where the grants come from the config and the rows therefore stay.
 */

/**
 * Why this app may be missing, in one sentence.
 *
 * `availabilityKind` comes from the catalogue (server/routes/agents/toolCatalog.js). The picker-wide sentence
 * is about a connection that the user did not make, and that is not the only thing "not available" can mean:
 * `browse_web` sits behind a docker probe, so on one installation it is there and on another it is not.
 * ABSENT, NOT AVAILABLE ON THIS INSTALLATION and NOT GRANTED are three different things. Here only the one
 * that is true is said.
 *
 * `null` means "the general sentence is enough". That is also where an unknown kind lands: an invented
 * explanation is worse than the general one.
 */
function unavailableHintFor(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, app: ToolApp) {
    // More than one possible cause ⇒ none of the specific sentences. One of those would assert a fact
    // that the measurement does not yield.
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
 * The apps as the picker shows them.
 *
 * The NAME falls back to the static list of the frontend (the same fallback as on the card: "Drive" rather
 * than "google-drive"). An app that this user may not use stays VISIBLE: it may work for someone else, because
 * the agent runs by default in the name of the asker. An app that this INSTALLATION does not have stays for the
 * same reason. Hiding it is the only reading that is neither "absent" nor "not granted", and then there is
 * nothing to untick either.
 */
function namedApps(apps: ToolApp[] | null, labels: Map<string, string> | Record<string, unknown> | null, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    if (!Array.isArray(apps)) return [];
    // Eén rij per grant-subject: twee entries over dezelfde module (Outlook en
    // Outlook read-only) leveren dezelfde tools, en de runtime laat ze allebei
    // meebeslissen. Twee losse rijen lieten één vinkje ERBIJ er stil twee AF
    // nemen op de rij ernaast. Zie `foldSharedApps`.
    apps = foldSharedApps(apps);
    const labelOf = (id: string) => {
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
 * Adjust one app in the staged selection.
 *
 * An app whose actions are UNKNOWN (`null`) stays untouched. You cannot choose what you cannot see, and making
 * it an empty set by accident would store a refusal that nobody stated.
 */
function withPicked(prev: SelectionMap | null, appId: string, mutate: (picked: Set<string>) => void) {
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
 * The texts of the shared shell, translated.
 *
 * The shell itself has no `t()`. It is also rendered by two surfaces that have none. Whoever has one passes
 * them in here. The English defaults in `PICKER_TEXT` remain the fallback.
 */
function chooserText(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
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

/** The two states that yield no picker: still busy, or failed. */
interface ChooserNoticeProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    kind: string;
    onRetry?: React.MouseEventHandler<HTMLButtonElement>;
    onClose: () => void;
}

function ChooserNotice({ t, kind, onRetry, onClose }: ChooserNoticeProps) {
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
interface ChooserFooterProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    ro: boolean;
    delta: { added: number; removed: number; dirty: boolean; };
    degraded: boolean;
    firstCuration: boolean;
    onApply: () => void;
}

function ChooserFooter({ t, ro, delta, degraded, firstCuration, onApply }: ChooserFooterProps) {
    // Read-only: the picker SHOWS what is switched on, but offers no button that starts a save that the server
    // would refuse anyway. The ticks themselves are off via `readOnly` on the shell, so there is nothing to count here either.
    if (ro) {
        return (
            <p className="text-[12px] text-[var(--text-tertiary)]" data-testid="agent-tool-chooser-readonly">
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
                <p className="text-[11px] text-[var(--warning)]" data-testid="agent-tool-chooser-degraded">
                    {t('agent_studio.can_use.tools_degraded', 'Could not check which apps you are allowed to use, so nothing is claimed about that here.')}
                </p>
            )}
            {firstCuration && (
                <p className="text-[11px] text-[var(--warning)]" data-testid="agent-tool-chooser-first-curation">
                    {t('agent_studio.can_use.chooser_first_curation', 'This is the first time you limit this agent: from now on it gets only what is ticked here, and actions that send always ask a person first.')}
                </p>
            )}
            <div className="flex items-center gap-3 flex-wrap">
                <button
                    type="button"
                    onClick={onApply}
                    disabled={!delta.dirty}
                    data-testid="agent-tool-chooser-apply"
                    className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 bg-[var(--accent-primary)]"
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

interface ToolChooserProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    ro?: boolean;
    open?: boolean;
    focusAppId?: string | null;
    apps?: ToolApp[] | null;
    catalogState?: string;
    catalogDegraded?: boolean;
    onRetryCatalog: () => void;
    labels?: Map<string, string> | Record<string, unknown> | null;
    toolsConfig?: ToolsConfig | null;
    onCommit?: (out: ReturnType<typeof commitSelection>) => void;
    enabledIntegrations?: string[] | null;
    onClose: () => void;
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
}: ToolChooserProps) {
    const shownApps = useMemo(() => namedApps(apps, labels, t), [apps, labels, t]);

    const [initial, setInitial] = useState<SelectionMap | null>(null);
    const [selection, setSelection] = useState<SelectionMap | null>(null);

    // Start over whenever the picker OPENS or there are OTHER apps.
    //
    // The dependency is deliberately the LIST OF APP IDS and not the apps object. The editor redraws for
    // everything that has nothing to do with the picker (save status, an incoming read, a relative time) and
    // then passes a fresh array. Going by identity would mean the picker goes back to the config in the middle
    // of ticking and throws away what someone is busy with: a loss that you only notice at "apply".
    //
    // `toolsConfig` is deliberately NOT in here for the same reason: it changes through our own save.
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

    const toggle = (name: string | undefined, app: ToolApp) => setSelection(prev => withPicked(prev, app.id, picked => {
        if (picked.has(name as string)) picked.delete(name as string); else picked.add(name as string);
    }));

    // "All on/off" works on the VISIBLE actions (the shell passes them along), so that an active filter does not
    // silently switch the hidden rows as well.
    const toggleApp = (app: ToolApp, on: boolean, visibleActions: { name?: string; label?: string; effect?: string }[]) => setSelection(prev => withPicked(prev, app.id, (picked) => {
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
