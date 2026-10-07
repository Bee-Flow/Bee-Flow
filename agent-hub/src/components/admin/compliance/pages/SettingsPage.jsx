import { ChevronDown, Save } from 'lucide-react';
import React, { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import useConfirm from '../../../shared/useConfirm';
import StatusPill from '../shared/StatusPill';
import { PAGE_FRAME } from './audits/auditForms';
import { SETTINGS_GROUPS, normaliseSettings, buildSettingsBody, groupIsInactive } from './settings/settingsFields';
import SettingsGroup from './settings/SettingsGroup';
import { groupProgress } from './settings/settingsLayout';

/**
 * SettingsPage — the compliance settings form, grouped per framework.
 *
 * The form logic is the legacy page's (normalise → edit → one PUT), but the
 * fields now come from the table in `settings/settingsFields.js`, which names
 * every `compliance_settings` column of PLAN.md §1.3. The save body is built
 * from that allow-list, never from the form object minus a few keys — a column
 * added next year must be declared before it can travel.
 *
 * Framework relevance ("do we serve financial entities?") is NOT a settings
 * column: it goes to `data.frameworks.setRelevance(id, value)` the moment it is
 * answered, like everywhere else in the hub.
 *
 * Edits are never lost silently. The form is dirty while its save body
 * differs from the one last loaded or saved (`saved`); Save is enabled only
 * then. While dirty the page sets the hub's leave guard (`setLeaveGuard`),
 * which asks through useConfirm before any rail or header navigation, and a
 * `beforeunload` handler for closing or reloading the tab. Both go once the
 * form is saved, and on unmount.
 *
 * The groups of frameworks that are off sit in ONE disclosure under the
 * others; their answers stay editable there. Groups with unanswered
 * questions open by default, decided once when the settings first arrive.
 *
 * The page is its own full-width scroller (the wheel works anywhere over the
 * pane); the groups sit in an 860px column, and the Save bar is a sticky
 * footer outside that padded column, so nothing scrolls visibly under it.
 *
 * Page props object per fe-1: `data.core.settings` / `data.core.saveSettings`,
 * `data.orgUsers`, `data.frameworks`, `setLeaveGuard`.
 */

/** Groups that open by default — the rest is one click away. */
const DEFAULT_OPEN = Object.freeze(['general', 'ai_act']);

/** Active groups that open on arrival: the defaults plus every group with a question left. */
function openOnArrival(groups, form, relevanceOf) {
    const o = {};
    for (const g of groups) {
        const p = groupProgress(g, form, relevanceOf);
        o[g.id] = DEFAULT_OPEN.includes(g.id) || p.answered < p.total;
    }
    return o;
}

/**
 * The form and its baseline (the settings as last loaded or saved). Fresh
 * settings from the server (first read, or the refresh after a save) replace
 * both, during render, so the first paint already shows them. Dirty is a
 * difference in the save BODY, so a change typed and taken back is not one.
 */
function useSettingsForm(settings) {
    const [form, setForm] = useState(() => normaliseSettings(settings));
    const [saved, setSaved] = useState(() => normaliseSettings(settings));
    const [seenSettings, setSeenSettings] = useState(settings);
    if (seenSettings !== settings) {
        setSeenSettings(settings);
        const next = normaliseSettings(settings);
        setForm(next);
        setSaved(next);
    }
    const dirty = useMemo(
        () => JSON.stringify(buildSettingsBody(form)) !== JSON.stringify(buildSettingsBody(saved)),
        [form, saved],
    );
    return { form, setForm, saved, setSaved, dirty };
}

/**
 * Which groups are open: the reader's own toggles over the arrival default,
 * which is decided once, when the settings first arrive (a group does not
 * fold shut the moment its last question is answered).
 */
function useGroupOpen(ready, settings, activeGroups, relevanceOf) {
    const [toggled, setToggled] = useState({});
    const [arrivalOpen, setArrivalOpen] = useState(null);
    if (ready && arrivalOpen === null) setArrivalOpen(openOnArrival(activeGroups, normaliseSettings(settings), relevanceOf));
    const onToggle = (id) => (next) => setToggled(prev => ({ ...prev, [id]: next }));
    return {
        active: (g) => ({ open: toggled[g.id] ?? arrivalOpen?.[g.id] ?? DEFAULT_OPEN.includes(g.id), onToggle: onToggle(g.id) }),
        off: (g) => ({ open: toggled[g.id] ?? false, onToggle: onToggle(g.id) }),
    };
}

/**
 * The edit's leave guard: while `dirty`, the hub asks through useConfirm
 * before navigating away, and the browser asks before the tab closes. Both
 * go when the form is clean again (saved) and on unmount. Returns the
 * confirm dialog to mount.
 */
function useLeaveGuard(dirty, setLeaveGuard) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    useEffect(() => {
        if (!dirty) return undefined;
        const hub = typeof setLeaveGuard === 'function' ? setLeaveGuard : null;
        hub?.(() => confirm({
            title: t('compliance.set_leave_confirm', 'Discard unsaved settings?'),
            description: t('compliance.set_leave_desc', 'The changes you made here have not been saved.'),
            confirmLabel: t('compliance.set_leave_discard', 'Discard changes'),
            cancelLabel: t('common.cancel', 'Cancel'),
            destructive: true,
        }));
        const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = ''; };
        window.addEventListener('beforeunload', onBeforeUnload);
        return () => {
            hub?.(null);
            window.removeEventListener('beforeunload', onBeforeUnload);
        };
    }, [dirty, setLeaveGuard, confirm, t]);
    return confirmDialog;
}

export default function SettingsPage({ data = {}, isMobile = false, setLeaveGuard = null }) {
    const { t } = useTranslation();
    const core = data.core || {};
    const frameworks = data.frameworks || null;
    const orgUsers = data.orgUsers ?? null;
    const settings = core.settings;
    const ready = !!settings && typeof settings === 'object';

    const { form, setForm, saved, setSaved, dirty } = useSettingsForm(settings);
    const [saving, setSaving] = useState(false);
    const [offOpen, setOffOpen] = useState(false);
    const confirmDialog = useLeaveGuard(dirty, setLeaveGuard);

    const relevanceOf = (id) => frameworks?.byId?.(id)?.relevance || 'unknown';
    const setRelevance = (id, value) => frameworks?.setRelevance?.(id, value);
    const activeGroups = SETTINGS_GROUPS.filter(g => !groupIsInactive(g, frameworks));
    const offGroups = SETTINGS_GROUPS.filter(g => groupIsInactive(g, frameworks));
    const openState = useGroupOpen(ready, settings, activeGroups, relevanceOf);

    const update = (name, value) => {
        if (name === '__fill_dpo__') {
            const u = value || {};
            setForm(prev => ({ ...prev, dpo_name: u.displayName || prev.dpo_name, dpo_email: u.email || prev.dpo_email, dpo_phone: u.phone || prev.dpo_phone }));
            return;
        }
        setForm(prev => ({ ...prev, [name]: value }));
    };

    const save = async () => {
        if (!ready || saving || !dirty) return;
        setSaving(true);
        const submitted = form;
        try {
            await core.saveSettings?.(buildSettingsBody(submitted));
            setSaved(submitted);
        } catch { /* the hook owns the error toast */ }
        finally { setSaving(false); }
    };

    const publicDsrUrl = useMemo(() => {
        const base = String(form.public_base_url || '').trim().replace(/\/+$/, '')
            || (typeof window !== 'undefined' && window.location ? window.location.origin : '');
        return `${base}/privacy/requests`;
    }, [form.public_base_url]);

    const generalFooters = {
        public: (
            <div className="rounded-[10px] bg-[var(--bg-tertiary)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]" data-testid="settings-dsr-hint">
                {t('compliance.public_dsr_hint', 'Data subjects can submit privacy requests without an account — link this page from your privacy notice:')}{' '}
                <code className="text-[11px] text-[var(--text-primary)] [overflow-wrap:anywhere]">{publicDsrUrl}</code>
            </div>
        ),
    };

    const groupProps = (g, inactive) => ({
        group: g, form, saved, onChange: update, orgUsers, inactive, relevanceOf, onRelevance: setRelevance,
        ...(inactive ? openState.off(g) : openState.active(g)),
    });
    const column = `w-full ${isMobile ? '' : 'max-w-[860px]'}`;

    return (
        <div className="h-full min-h-0 overflow-y-auto flex flex-col" data-testid="settings-page">
            <div className={`${column} ${PAGE_FRAME}`}>
                {!ready && (
                    <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="settings-loading">
                        {t('compliance.set_loading', 'Reading your compliance settings…')}
                    </div>
                )}

                {activeGroups.map(g => (
                    <SettingsGroup key={g.id} {...groupProps(g, false)} sectionFooters={g.id === 'general' ? generalFooters : null} />
                ))}

                {offGroups.length > 0 && (
                    <FrameworksOff groups={offGroups} open={offOpen} onToggle={setOffOpen} t={t}>
                        {offGroups.map(g => (
                            <SettingsGroup key={g.id} {...groupProps(g, true)} />
                        ))}
                    </FrameworksOff>
                )}
            </div>

            <div className="sticky bottom-0 z-10 mt-auto border-t border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <div className={`${column} px-3.5 @[1100px]/cpage:px-5 py-2.5 flex items-center gap-2`}>
                    <button
                        type="button"
                        onClick={save}
                        disabled={!ready || saving || !dirty}
                        style={PRIMARY_ACTION_STYLE}
                        className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid="settings-save"
                    >
                        <Save size={13} aria-hidden="true" />
                        {saving ? t('compliance.saving', 'Saving…') : t('compliance.save', 'Save')}
                    </button>
                    {dirty && !saving && (
                        <StatusPill tone="warning" testId="settings-dirty">{t('compliance.set_unsaved', 'Unsaved changes')}</StatusPill>
                    )}
                </div>
            </div>
            {confirmDialog}
        </div>
    );
}

/**
 * The groups of the frameworks that are off, behind one disclosure: their
 * names and the "answers are kept" sentence are visible while it is closed.
 */
function FrameworksOff({ groups, open, onToggle, t, children }) {
    const panelId = useId();
    return (
        <section className="shrink-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-sm)]" data-testid="settings-frameworks-off">
            <button
                type="button"
                onClick={() => onToggle(!open)}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
                className="w-full flex items-start gap-2 px-3.5 py-3 text-left rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]"
                data-testid="settings-frameworks-off-toggle"
            >
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                    <span className="text-sm font-bold text-[var(--text-primary)]">
                        {t('compliance.set_frameworks_off', 'Frameworks that are off ({n})', { n: groups.length })}
                    </span>
                    <span className="text-xs text-[var(--text-secondary)]" data-testid="settings-frameworks-off-names">
                        {groups.map(g => t(g.titleKey, g.titleEn)).join(' · ')}
                    </span>
                    <span className="text-[11px] text-[var(--text-tertiary)]">
                        {t('compliance.set_frameworks_off_note', 'The answers are kept and start counting when you turn the framework on.')}
                    </span>
                </span>
                <ChevronDown size={14} aria-hidden="true" className={`mt-1 shrink-0 text-[var(--text-tertiary)] transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
            {open && (
                <div id={panelId} className="px-3.5 pb-3.5 flex flex-col gap-3" data-testid="settings-frameworks-off-body">
                    {children}
                </div>
            )}
        </section>
    );
}

export { SETTINGS_GROUPS, buildSettingsBody, normaliseSettings };
