import { Plus, Search, Workflow } from 'lucide-react';
import React, { useEffect, useMemo, useState } from 'react';
import { INPUT_CLS } from './panels/kit';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import useTranslation from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import Spinner from '../../../../shared/Spinner';

/**
 * RoutinePicker — modal search over the user's routines (automations),
 * using the same listAutomations() the AITasksDesigner sidebar uses
 * (GET /api/automation → { automations }). `onPick` receives the FULL
 * automation object so the caller can read its trigger contract
 * (agent_call parametersSchema → input-mapping prefill).
 *
 * Routines with an `app_trigger` trigger sort first ("Built for apps" —
 * the purpose-built kind: typed inputs incl. files), then `agent_call`
 * ("Best for apps" — a typed contract, built to be invoked
 * programmatically), then everything else.
 */

const TRIGGER_LABELS = {
    app_trigger: 'Studio App',
    agent_call: 'Agent call',
    schedule: 'Schedule',
    webhook: 'Webhook',
    app_event: 'App event',
    manual: 'Manual',
};

/**
 * The badges beside a routine's name.
 *
 * They used to be hardcoded Tailwind hues — emerald-500 and sky-500 text on a
 * 10%-alpha tint of the same hue — which lands near 2.2:1 at 10px and ignores
 * the theme entirely. They carry no meaning a colour needs to encode ("Active",
 * "Built for apps"), so they read as ordinary chips in the token palette, at
 * the same 11px the trigger-kind chip beside them already uses.
 */
const PILL_CLS = 'shrink-0 text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-medium';

// Lower sorts first: contract-carrying kinds lead the list.
const KIND_RANK = { app_trigger: 0, agent_call: 1 };

function triggerKindOf(automation) {
    return automation?.definition?.trigger?.kind || automation?.triggerType || 'manual';
}

export default function RoutinePicker({ open, onClose, onPick, formFields = [], appRef = null }) {
    return (
        <Modal open={open} onClose={onClose} title="Choose a routine" size="lg">
            {/* Body mounts fresh on every open, so search + results reset. */}
            {open ? <RoutinePickerBody onPick={onPick} formFields={formFields} appRef={appRef} /> : null}
        </Modal>
    );
}

function RoutinePickerBody({ onPick, formFields, appRef }) {
    const api = useAutomationApi();
    const [automations, setAutomations] = useState(null); // null = loading
    const [error, setError] = useState(null);
    const [query, setQuery] = useState('');

    useEffect(() => {
        let cancelled = false;
        api.listAutomations()
            .then((r) => { if (!cancelled) setAutomations(r.automations || []); })
            .catch((e) => { if (!cancelled) { setError(e.message); setAutomations([]); } });
        return () => { cancelled = true; };
    }, [api]);

    const filtered = useMemo(() => {
        const list = automations || [];
        const q = query.trim().toLowerCase();
        const matches = q
            ? list.filter((a) =>
                (a.title || '').toLowerCase().includes(q)
                || (a.description || '').toLowerCase().includes(q))
            : list;
        // Contract-carrying kinds first: app_trigger, then agent_call.
        return [...matches].sort((a, b) => {
            const aa = KIND_RANK[triggerKindOf(a)] ?? 2;
            const bb = KIND_RANK[triggerKindOf(b)] ?? 2;
            return aa - bb;
        });
    }, [automations, query]);

    return (
        <div className="flex flex-col gap-3">
            <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
                <input
                    type="text"
                    className={`${INPUT_CLS} pl-9`}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search routines…"
                    aria-label="Search routines"
                    spellCheck={false}
                />
            </div>

            {automations === null && (
                <div className="flex items-center justify-center py-8"><Spinner size="sm" /></div>
            )}
            {error && (
                <p className="text-xs text-rose-500 py-2">Could not load routines: {error}</p>
            )}
            {automations !== null && !error && filtered.length === 0 && (
                <p className="text-sm text-[var(--text-secondary)] py-6 text-center">
                    {query ? 'No routines match your search.' : 'No routines yet.'}
                </p>
            )}

            {/* There was no way out of here but to leave: the empty state said
                "build one in Routines first", so wiring a button to new work
                meant abandoning the app editor. This makes one, already shaped
                for this app — a Studio App trigger whose inputs are the fields
                of the form the action sits in. */}
            {automations !== null && !error ? (
                <CreateRoutineRow formFields={formFields} appRef={appRef} onCreated={onPick} />
            ) : null}

            <ul className="flex flex-col gap-1.5" aria-label="Routines">
                {filtered.map((a) => {
                    const kind = triggerKindOf(a);
                    return (
                        <li key={a.id}>
                            <button
                                type="button"
                                onClick={() => onPick(a)}
                                className="w-full text-left rounded-lg border border-[var(--border-subtle)] px-3 py-2.5 hover:border-[var(--accent-primary)] hover:bg-[var(--bg-tertiary)]/40 transition-colors"
                            >
                                <div className="flex items-center gap-2 min-w-0">
                                    <Workflow className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" />
                                    <span className="text-sm font-medium text-[var(--text-primary)] truncate">
                                        {a.title || 'Untitled routine'}
                                    </span>
                                    {a.isActive && (
                                        <span className={PILL_CLS}>
                                            Active
                                        </span>
                                    )}
                                    <span className="shrink-0 ml-auto text-[11px] px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                                        {TRIGGER_LABELS[kind] || kind}
                                    </span>
                                    {kind === 'app_trigger' && (
                                        <span className={PILL_CLS}>
                                            Built for apps
                                        </span>
                                    )}
                                    {kind === 'agent_call' && (
                                        <span className={PILL_CLS}>
                                            Best for apps
                                        </span>
                                    )}
                                </div>
                                {a.description ? (
                                    <p className="text-xs text-[var(--text-secondary)] mt-1 truncate">{a.description}</p>
                                ) : null}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </div>
    );
}

/**
 * Make a routine from here, already shaped for this app.
 *
 * It gets an `app_trigger`, whose declared params become `trigger.output.<name>`
 * inside the routine — the purpose-built contract for being called by an app.
 * The params are seeded from the fields of the form the action sits in, so the
 * input mapping the picker fills in afterwards lines up with no typing.
 *
 * It also gets a BACK-POINTER — `trigger.appRef = { appId, screenId, nodeId }`
 * — naming the button it was made from. Without it a routine made from here is
 * indistinguishable in the builder from one typed up by hand: same nameless
 * "Studio App trigger", no way back to the screen it belongs to, and nothing
 * to say when that screen is later deleted. It is a LABEL and nothing more:
 * what may be told about those ids is decided per viewer, server-side
 * (server/appStudio/appRefLookup.js), and running the routine is still gated
 * on owner-equality in the action bridge.
 *
 * ── WHOSE routine it becomes is the server's answer, not this row's ────────
 *
 * The routine made here is run by ONE app action, and that action runs
 * ACTS-AS-OWNER: the bridge refuses when the routine's owner is not the app's
 * owner. So it may only be made when the person clicking IS the app owner —
 * anything else would either break the button on its first press or hand the
 * clicker a routine running with somebody else's permissions.
 *
 * That check cannot live here: this component knows the app's ID, never its
 * owner, and a client-side answer would be a suggestion anyway. The create
 * route decides (server/routes/automation/crud.js → appRefOwnerVerdict) and
 * answers 403 with a `code`; this row turns the code into a sentence. An
 * unrecognised refusal falls back to the server's own words rather than a
 * guess — including "I could not tell whose app this is", which is a refusal
 * and not a reason to try anyway.
 *
 * `automations` is also a separately licensed feature, and that refusal is a
 * different sentence with a different way out. The two used to be one branch
 * matching /403/, so an ownership refusal appeared on screen as a billing
 * problem — the code is what keeps them apart.
 */

/**
 * The refusal codes the create route sends back, as sentences.
 *
 * Keyed on `code`, never on the message text: the server's wording is English
 * and may change, and matching prose is how the licence branch swallowed every
 * other 403 in the first place.
 */
const OWNER_REFUSAL_KEYS = {
    owner_mismatch: {
        key: 'app_studio.routine_picker.refused_owner_mismatch',
        en: 'This app belongs to someone else. A routine made here would run with their permissions, so only the app owner can make one. Picking an existing routine still works.',
    },
    owner_unknown: {
        key: 'app_studio.routine_picker.refused_owner_unknown',
        en: 'This app does not say who owns it, so there is nobody to make the routine under. Picking an existing routine still works.',
    },
    app_unknown: {
        key: 'app_studio.routine_picker.refused_app_unknown',
        en: 'The app this button belongs to could not be read, so it is not clear who the routine would belong to. Try again in a moment, or pick an existing routine.',
    },
    actor_unknown: {
        key: 'app_studio.routine_picker.refused_actor_unknown',
        en: 'It is not clear who is signed in, so no routine was made. Sign in again and try once more.',
    },
};

/**
 * Weigeringen die NIET over eigendom gaan, ook op `code` en niet op proza.
 *
 * `/api/automation` hangt achter `requireLicenseFeature('automations')`, en die
 * poort antwoordt `{ error: 'feature_locked' }` — in dat woord zit noch
 * "tier_required" noch "licen", dus een tak die op de ZIN matchte was
 * onbereikbaar voor de poort die er in werkelijkheid staat, en de gebruiker
 * kreeg de kale servertekst `feature_locked` in het rode zinnetje. `err.code`
 * reist al mee (hooks/useAutomationApi.js), dus vertakken hoort net als bij de
 * eigendomsweigering op de code te gebeuren.
 *
 * `tier_unavailable` staat erbij omdat dezelfde middleware hem stuurt zodra de
 * licentie tijdelijk niet te bepalen is: dat is een ANDER antwoord dan "dit
 * plan heeft het niet" en verdient een andere zin — de gebruiker moet het zo
 * meteen opnieuw proberen in plaats van te gaan upgraden.
 */
const OTHER_REFUSAL_KEYS = {
    feature_locked: {
        key: 'app_studio.routine_picker.refused_licence',
        en: 'Routines are not part of this plan, so a new one cannot be made here. An existing routine still works.',
    },
    tier_unavailable: {
        key: 'app_studio.routine_picker.refused_tier_unavailable',
        en: 'The plan could not be checked just now, so no routine was made. Try again in a moment, or pick an existing routine.',
    },
    not_found: {
        key: 'app_studio.routine_picker.refused_module_off',
        en: 'Routines are switched off here, so a new one cannot be made. Picking an existing routine still works.',
    },
};

/**
 * De machinenaam van een weigering — `code` als de server er een meestuurt,
 * anders het `error`-veld als dat een KALE token is (`feature_locked`,
 * `tier_unavailable`, `not_found`). De licentie- en modulepoorten sturen geen
 * `code`; hun hele antwoord is dat token.
 *
 * Exacte gelijkheid op een token, niet een substring in een zin: dat laatste is
 * wat hier eerder stond (`/tier_required|licen/i`) en het matchte op geen enkel
 * antwoord dat de server werkelijk stuurt, terwijl het bij een gewone
 * foutmelding waarin toevallig "licen…" voorkwam wél zou aanslaan.
 */
function refusalCode(err) {
    if (typeof err?.code === 'string' && err.code) return err.code;
    const message = String(err?.message || '');
    return /^[a-z][a-z0-9_]*$/.test(message) ? message : null;
}

function CreateRoutineRow({ formFields, appRef = null, onCreated }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // app_trigger param names are /^[A-Za-z][A-Za-z0-9_]{0,59}$/ and a leading
    // underscore is reserved for the audit keys the payload carries.
    const params = (formFields || [])
        .filter((f) => /^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(f.name || ''))
        .slice(0, 50)
        .map((f) => ({
            name: f.name,
            type: f.type === 'input_file' ? 'file' : f.type === 'input_number' ? 'number' : f.type === 'input_checkbox' ? 'boolean' : 'string',
            required: false,
            description: '',
        }));

    const create = async () => {
        setBusy(true);
        setError(null);
        try {
            const { automation } = await api.createAutomation({
                title: 'New routine for this app',
                description: 'Called by a Studio app action.',
                triggerType: 'manual',
                definition: {
                    trigger: {
                        id: 'trg', type: 'trigger', kind: 'app_trigger', params,
                        // Only a WHOLE reference is written. Two thirds of a
                        // pointer names nothing, and the server rejects a
                        // half-written one at save time — better to store no
                        // back-pointer than one that renders as "App · ".
                        ...(appRef?.appId && appRef?.screenId && appRef?.nodeId
                            ? { appRef: { appId: appRef.appId, screenId: appRef.screenId, nodeId: appRef.nodeId } }
                            : {}),
                    },
                    steps: [],
                    edges: [],
                },
            });
            onCreated(automation);
        } catch (e) {
            const message = String(e?.message || e);
            const code = refusalCode(e);
            const refusal = OWNER_REFUSAL_KEYS[code] || OTHER_REFUSAL_KEYS[code];
            if (refusal) {
                setError(t(refusal.key, refusal.en));
            } else {
                setError(message);
            }
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-1.5 pt-2 border-t border-[var(--border-subtle)]">
            <button
                type="button"
                onClick={create}
                disabled={busy}
                className="self-start inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                {busy ? 'Making it…' : 'Make a routine for this app'}
            </button>
            <span className="text-[11px] text-[var(--text-secondary)]">
                {/* The plural is chosen by picking the KEY, never by gluing an
                    "s" onto a translated word — most languages do not form a
                    plural that way, and "input(s)" is not a sentence anybody
                    writes. */}
                {params.length
                    ? t(
                        params.length === 1
                            ? 'app_studio.routine_picker.seeded_inputs'
                            : 'app_studio.routine_picker.seeded_inputs_plural',
                        params.length === 1
                            ? 'It starts with {n} input matching this form.'
                            : 'It starts with {n} inputs matching this form.',
                        { n: params.length },
                    )
                    : t('app_studio.routine_picker.seeded_empty', 'It starts with a Studio App trigger, ready for inputs.')}
            </span>
            {error ? <span className="text-[11px] text-[var(--error)]">{error}</span> : null}
        </div>
    );
}
