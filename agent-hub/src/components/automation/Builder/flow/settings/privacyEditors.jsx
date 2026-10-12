// The Privacy Shield step editor (one node, four modes), extracted verbatim
// from SettingsForm.jsx.
import { useEffect, useMemo, useState } from 'react';
import { piiCategoriesLocalized } from '../../../../../config/piiCategories';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import PathField from '../../mapping/PathField';
import AccordionSection from '../AccordionSection';
import { readPrivacy, PRIVACY_MODES, modeScans, modeBranches, modeHides, droppedEdgesOnModeChange } from '../privacyModel';
import { FormRow, inputClass } from './formPrimitives';

/**
 * "Show real values again" — one field, because there is one decision.
 *
 * It does not scan, so it has no categories and no threshold: it looks up
 * placeholders in the run's own vault. Everything it can and cannot resolve is
 * reported on the node after a run.
 */
/**
 * The Privacy Shield step's editor — one node, four modes (BFSF-355).
 *
 * "Check for personal data", "Hide personal data" and "Show real values again"
 * used to be three palette entries with two editors between them, and nothing
 * told you that a reveal only means something after a hide. They are one node
 * now; flow/privacyModel.js maps the mode onto the runtime type the engine
 * already speaks, so stored automations open here unchanged.
 *
 * Deliberately short beyond the mode: the org's Privacy Shield already decides
 * what counts as personal data, how sure the detector has to be, and what an
 * allowlist lets through. Re-asking all of that per step would let one automation
 * quietly hold itself to a weaker standard than the organisation — so the only
 * knobs here NARROW that policy, and the copy says which parts are inherited.
 */
function PrivacyShieldFields({ step, draft, set, groups, onFocusField, previewSample, errorSections = new Set(), stepEdges = [] }) {
    const { t } = useTranslation();
    const categories = useMemo(() => piiCategoriesLocalized(t), [t]);
    const guardTrouble = useGuardAvailability();
    const privacy = draft.privacy || readPrivacy(step);
    const setPrivacy = (patch) => set('privacy', { ...privacy, ...patch });
    const mode = privacy.mode;
    const scans = modeScans(mode);
    const hides = modeHides(mode);
    const branches = modeBranches(mode);
    const selected = Array.isArray(privacy.categories) ? privacy.categories : null;

    // A mode switch can change the node's PORTS, and the canvas would drop the
    // edges the new shape has nowhere to put. Ask before that costs wiring —
    // the same stance RouteFields takes when collapsing a router.
    const [modeAsk, setModeAsk] = useState(null);
    const chooseMode = (next) => {
        if (next === mode) return;
        const dropped = droppedEdgesOnModeChange(step, next, stepEdges);
        if (dropped.length) { setModeAsk({ next, dropped }); return; }
        setPrivacy({ mode: next });
    };

    const sourceLabel = mode === 'reveal' ? 'What to restore'
        : mode === 'hide' ? 'What to hide it in'
            : mode === 'check_hide' ? 'What to scan and hide'
                : 'What to scan';
    const sourceHint = mode === 'reveal'
        ? 'The value that still holds placeholders — usually the output of a step that worked on hidden data.'
        : 'Any value from an earlier step — an email body, a document\'s text, a form answer. Objects are scanned whole.';

    const toggleCategory = (id) => {
        // No selection means "everything the org looks for". The first tick
        // therefore starts from that whole list rather than from nothing —
        // otherwise one click would silently narrow the scan to a single
        // category, which is the opposite of what ticking a box suggests.
        const base = selected || categories.map(c => c.id);
        const next = base.includes(id) ? base.filter(c => c !== id) : [...base, id];
        setPrivacy({ categories: next.length && next.length < categories.length ? next : null });
    };

    return (
        <>
            <AccordionSection stepType={step.type} sectionKey="config" title={t('automations.privacy_editors.configuration', 'Configuration')} defaultOpen forceOpen={errorSections.has('config')}>
                <FormRow label={t('automations.privacy_editors.what_should_this_step_do', 'What should this step do?')}>
                    <div className="flex flex-col gap-1">
                        {PRIVACY_MODES.map((m) => (
                            <button
                                key={m.id}
                                type="button"
                                onClick={() => chooseMode(m.id)}
                                aria-pressed={mode === m.id}
                                className={`text-left px-2.5 py-1.5 rounded border text-xs transition ${mode === m.id
                                    ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]'
                                    : 'border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                            >
                                <span className="font-semibold">{m.label}</span>
                                <span className="block text-[11px] text-[var(--text-tertiary)]">{m.blurb}</span>
                            </button>
                        ))}
                    </div>
                </FormRow>

                {modeAsk && (
                    <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                        <p className="mb-1.5">
                            {t('automations.privacy_editors.switching_to', 'Switching to')} <strong>{PRIVACY_MODES.find(m => m.id === modeAsk.next)?.label}</strong> {t('automations.privacy_editors.removes', 'removes')}{' '}
                            {modeAsk.dropped.map(d => `the "${d.port}" connection`).join(' and ')} — {modeAsk.dropped[0].why}.
                        </p>
                        <div className="flex gap-2">
                            <button type="button" className="underline font-semibold"
                                onClick={() => { const next = modeAsk.next; setModeAsk(null); setPrivacy({ mode: next }); }}>
                                {t('automations.privacy_editors.switch_anyway', 'Switch anyway')}
                            </button>
                            <button type="button" className="underline" onClick={() => setModeAsk(null)}>{t('automations.privacy_editors.keep_this_mode', 'Keep this mode')}</button>
                        </div>
                    </div>
                )}

                <FormRow label={sourceLabel} hint={sourceHint}>
                    <PathField
                        value={privacy.sourceRef || ''}
                        onChange={(v) => setPrivacy({ sourceRef: v })}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        quickPicks={guardQuickPicks(groups)}
                        quickPicksLabel="Text from previous steps"
                        placeholder={t('automations.privacy_editors.pick_a_value_from_an_earlier', 'Pick a value from an earlier step')}
                    />
                </FormRow>

                {/* What happens next is the whole point of the step, and none of
                    it is discoverable from the node alone. */}
                {mode === 'reveal' && (
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('automations.privacy_editors.bind_the_next_step_to', 'Bind the next step to')} <code>output.text</code>{t('automations.privacy_editors.most_values_come_back_on_their', '. Most values come back on their own — an AI reply, a tool result — so this is only needed where one did not. Anything this run cannot account for is reported rather than left in the text.')}
                    </p>
                )}
                {mode === 'hide' && (
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('automations.privacy_editors.bind_the_next_step_to', 'Bind the next step to')} <code>output.text</code>{t('automations.privacy_editors.every_value_is_replaced_by_a', '. Every value is replaced by a placeholder like')}{' '}
                        <code>[email_1]</code>{t('automations.privacy_editors.and_the_real_values_are_put', ', and the real values are put back')} <strong>{t('automations.privacy_editors.automatically', 'automatically')}</strong> {t('automations.privacy_editors.wherever_the_run_uses_them_again', 'wherever the run uses them again — an AI reply, a tool result. For a value that never comes back that way, add a step in')} <strong>{t('automations.privacy_editors.show_real_values_again', 'Show real values again')}</strong> {t('automations.privacy_editors.mode_where_you_want_them_restored', 'mode where you want them restored.')}
                    </p>
                )}
                {branches && (
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('automations.privacy_editors.leaves_by', 'Leaves by')} <span className="font-semibold text-amber-600 dark:text-amber-400">{t('automations.privacy_editors.personal_data', 'personal data')}</span> {t('automations.privacy_editors.or', 'or')}{' '}
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">{t('automations.privacy_editors.clean', 'clean')}</span> {t('automations.privacy_editors.wire_an_alert_to_the_first', '— wire an alert to the first.')}
                        {mode === 'check_hide' && (
                            <> {t('automations.privacy_editors.the_hidden_copy_is_on', 'The hidden copy is on')} <code>output.text</code>{t('automations.privacy_editors.with_reversible_placeholders_a_later', ', with reversible placeholders — a later')}
                            <strong> {t('automations.privacy_editors.show_real_values_again', 'Show real values again')}</strong> {t('automations.privacy_editors.can_restore_it', 'can restore it.')}</>
                        )}
                    </p>
                )}
                {guardTrouble && scans && (
                    <p className="text-[11px] text-amber-600 dark:text-amber-400">
                        {t('automations.privacy_editors.the_privacy_shield_detector', 'The Privacy Shield detector')} {guardTrouble}{t('automations.privacy_editors.so_this_step_cannot_scan_right', ', so this step cannot scan right now. Which branch it takes then is your organisation’s Privacy Shield setting — but it will never report “clean” for a scan that did not happen.')}
                    </p>
                )}
                {branches && (
                <FormRow label={t('automations.privacy_editors.on_personal_data', 'On personal data')}>
                    <div className="flex flex-col gap-1.5">
                        <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                            <input type="checkbox" checked={!!privacy.stopOnFound} onChange={(e) => setPrivacy({ stopOnFound: e.target.checked })} className="mt-0.5 accent-[var(--accent)]" />
                            <span>
                                {t('automations.privacy_editors.stop_the_run', 'Stop the run')}
                                <span className="block text-[var(--text-tertiary)]">{t('automations.privacy_editors.the_run_fails_and_the_failure', 'The run fails, and the failure says which categories were found.')}</span>
                            </span>
                        </label>
                        <label className="flex items-start gap-2 text-xs text-[var(--text-secondary)]">
                            <input type="checkbox" checked={!!privacy.maskOnFound} onChange={(e) => setPrivacy({ maskOnFound: e.target.checked })} className="mt-0.5 accent-[var(--accent)]" />
                            <span>
                                {t('automations.privacy_editors.pass_a_masked_copy_on', 'Pass a masked copy on')}
                                <span className="block text-[var(--text-tertiary)]">
                                    {t('automations.privacy_editors.adds', 'Adds')} <code>output.masked</code>{t('automations.privacy_editors.with_every_value_replaced_by', ', with every value replaced by')} <code>[person]</code>{t('automations.privacy_editors.irreversible_the_original_is_not_recoverable', '. Irreversible — the original is not recoverable from it, unlike the placeholders')} <strong>{t('automations.privacy_editors.check_and_hide', 'Check and hide')}</strong> mints.
                                </span>
                            </span>
                        </label>
                    </div>
                </FormRow>
                )}
            </AccordionSection>
            {scans && (
            <AccordionSection stepType={step.type} sectionKey="advanced" title={t('automations.privacy_editors.advanced', 'Advanced')} forceOpen={errorSections.has('advanced')}>
                <FormRow label={hides && !branches ? 'Hide' : 'Look for'} hint={t('automations.privacy_editors.everything_the_organisation_looks_for_unless', 'Everything the organisation looks for, unless you narrow it here. A step can only look for LESS than the Privacy Shield does, never more.')}>
                    <div className="flex flex-wrap gap-1">
                        {categories.map((c) => {
                            const on = !selected || selected.includes(c.id);
                            return (
                                <button
                                    key={c.id}
                                    type="button"
                                    onClick={() => toggleCategory(c.id)}
                                    aria-pressed={on}
                                    // The id, not the label: the label is
                                    // translated, and the id is what actually
                                    // reaches the detector.
                                    data-pii-category={c.id}
                                    title={c.id}
                                    className={`px-2 py-0.5 rounded-full border text-[11px] transition ${on
                                        ? 'bg-[var(--accent)]/15 border-[var(--accent)]/40 text-[var(--accent)]'
                                        : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}`}
                                >
                                    {c.label}
                                </button>
                            );
                        })}
                    </div>
                </FormRow>
                <FormRow label={t('automations.privacy_editors.only_report_matches_above', 'Only report matches above')} hint={t('automations.privacy_editors.leave_empty_to_use_the_organisation', 'Leave empty to use the organisation\'s threshold. A higher number reports only what the detector is more sure about.')}>
                    <input
                        type="number" min={0} max={1} step={0.05}
                        value={privacy.confidence ?? ''}
                        onChange={(e) => setPrivacy({ confidence: e.target.value === '' ? null : Number(e.target.value) })}
                        placeholder={t('automations.privacy_editors.inherited', 'inherited')}
                        className={inputClass()}
                    />
                </FormRow>
            </AccordionSection>
            )}
        </>
    );
}

/** Upstream values worth scanning, offered as one-click picks. */
function guardQuickPicks(groups) {
    const picks = [];
    for (const g of groups || []) {
        const sample = g.sample;
        if (!sample || typeof sample !== 'object') continue;
        for (const [key, value] of Object.entries(sample)) {
            // Text is what a detector can read. A number or a boolean has no
            // personal data to find, and offering it is noise.
            if (typeof value !== 'string' || value.length < 3) continue;
            picks.push({ path: `${g.basePath}.${key}`, sample: value });
            if (picks.length >= 8) return picks;
        }
    }
    return picks;
}

/**
 * Can the shield's detector actually scan? A guard node that looks configured
 * but cannot scan is worse than no node, so the panel says so.
 *
 * `/api/guard/health` answers with a STATUS, and the four values mean different
 * things to an author:
 *   'not-configured' — no detector installed at all (server/index.js)
 *   'unavailable'    — installed, but the probe failed (it is down right now)
 *   'degraded'       — reachable, model not loaded (guard-service /health)
 *   'ok'             — fine, and the panel stays quiet
 *
 * Advisory only: it never blocks editing, and a failed probe says nothing
 * rather than claiming the detector is missing.
 */
const GUARD_TROUBLE = {
    'not-configured': 'is not installed',
    unavailable: 'is installed but not responding',
    degraded: 'is running but its model has not loaded',
};

function useGuardAvailability() {
    const [trouble, setTrouble] = useState(null);
    useEffect(() => {
        let alive = true;
        authFetch(`${API_BASE}/api/guard/health`)
            .then(r => (r.ok ? r.json() : null))
            .then((b) => { if (alive && b) setTrouble(GUARD_TROUBLE[b.status] || null); })
            .catch(() => { /* availability is advisory */ });
        return () => { alive = false; };
    }, []);
    return trouble;
}

export { PrivacyShieldFields };
