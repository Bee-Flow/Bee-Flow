import type { ToolApp } from '../agents/AgentWizard/canUse/toolCatalogTypes';
import type React from 'react';

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
 ZZ
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
 * ── TWO SELECTION MODELS, AND WHY ───────────────────────────────────
 * `selected` is a FLAT list of action names. That shape CANNOT tell "nothing
 * was said about this app" from "this app may do nothing" apart — and exactly
 * that difference is what the agent grants turn on (an app the map does not
 * mention keeps its whole toolbelt; see `AgentWizard/canUse/toolGrants.js`).
 * So a caller can pass `selection` instead: a set of its own per app, with
 * three states.
 *
 *   Set(...)     these actions are on (an EMPTY set is a real choice: none);
 *   missing      nothing was said about this app — the shell ticks nothing;
 *   null         this app's actions are UNKNOWN (the module did not load).
 *                There is then nothing to tick, and the shell does not offer
 *                it either: showing an empty list would claim "this app has
 *                no actions".
 *
 * The two existing consumers (the AI step and the App Studio connector picker)
 * keep using the flat shape; it does not know the distinction and does not
 * need it — there an unticked tool simply IS not chosen.
 *
 * ── THE EFFECT CHIPS ────────────────────────────────────────────────
 * As soon as the catalogue carries `effect` (`reads`/`writes`/`sends`), the
 * filter chips and the effect badges appear. If it does not, nothing changes:
 * chips that filter on a field that is not there hide everything.
 *
 * An action with an UNKNOWN effect falls under "Sends". That is the same
 * narrow reading the runtime takes (`sendsFor`, `normaliseToolsConfig`): we do
 * not know what it does, so it may send — and the row you look for under
 * "Sends" is exactly the row you do not want to miss.
 */

export type PickerAction = { name?: string; label?: string; description?: string; producesList?: boolean; sideEffect?: boolean; effect?: string; integrationLabel?: string };

export type PickerApp = Omit<ToolApp, 'actions'> & { unavailableHint?: string; actions?: PickerAction[] };

export interface PickerText {
    search: string;
    enableAll: string;
    disableAll: string;
    selectedOf: string;
    selectedOfOne: string;
    noMatch: string;
    actionsUnknown: string;
    filterAll: string;
    filterReads: string;
    filterWrites: string;
    filterSends: string;
    filterGroup: string;
    badgeReads: string;
    badgeWrites: string;
    badgeSends: string;
    badgeUnknown: string;
    badgeList: string;
    sendsNote: string | null;
    [key: string]: string | null;
}

/** Een badge in één token — tekst én rand in dezelfde kleur. */
export interface EffectBadgeProps {
    kind: string;
    label: string;
}

/** De chiprij. Verschijnt alleen als er effecten in de catalogus staan. */
export interface EffectFiltersProps {
    txt: PickerText;
    value: string;
    onChange: React.Dispatch<React.SetStateAction<string>>;
}

/** One action row. A row that CAN send is dimmed and says it asks first. */
export interface ActionRowProps {
    action: PickerAction;
    app: PickerApp;
    txt: PickerText;
    onToggle?: AppActionPickerProps['onToggle'];
    on: boolean;
    readOnly: boolean;
    showEffect: boolean;
}

export interface AppActionPickerProps {
    apps?: PickerApp[];
    selected?: string[];
    selection?: Map<string, Set<string> | string[] | null> | Record<string, Set<string> | string[] | null> | null;
    onToggle?: (actionName: string | undefined, app: PickerApp, action: PickerAction) => void;
    onToggleApp?: (app: PickerApp, turnOn: boolean, visibleActions: PickerAction[]) => void;
    text?: Partial<PickerText> | null;
    onClose: () => void;
    title?: string;
    emptyLabel?: string;
    footer?: React.JSX.Element | null;
    unavailableHint?: string;
    focusAppId?: string | null;
    readOnly?: boolean;
}
