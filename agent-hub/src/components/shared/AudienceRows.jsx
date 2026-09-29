import { Lock, Building2, Users, Plus, X } from 'lucide-react';
import React, { useRef, useState } from 'react';
import AnchoredMenu from './AnchoredMenu';
import {
    PERSONAL, ORG, GROUPS,
    audienceModeOf, makeGroupNamer, useAudienceActions, GroupChecklist,
} from './VisibilityCapsule';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * AudienceRows — the INLINE presentation of the visibility state, for
 * settings tabs (Knowledge artboard 1c "Wie mag hem zien en gebruiken",
 * Agents "Rol"). Same props and the same derivation as VisibilityCapsule;
 * three rows instead of a capsule + popover:
 *
 *   ┌ 🔒 Personal ─────────────────────────────┐
 *   ┌ 🏢 Entire organisation ───────────────────┐
 *   ┌ 👥 Groups  [Sales] [Binnendienst] [+] ────┐   ← selected: ink border, bold
 *   A helper line in --text-tertiary under the rows (caller-supplied `hint`).
 *
 * Chips are the selected groups (click one to remove it); "+" opens the org's
 * group list through AnchoredMenu. Choosing the Groups row itself never
 * publishes anything: an empty group list on a published thing means the
 * whole organisation, so the row just opens the picker and the first ticked
 * group is what shares it. Unticking the last chip goes back to Personal.
 *
 * `confirmWidening` applies the same rule as the capsule (widening asks,
 * narrowing does not) through the shared useAudienceActions.
 *
 * Extra props over the capsule: `title` (row-group heading), `hint` (the
 * consequence line under the rows), `disabled` (read-only viewers).
 */
export default function AudienceRows({
    t: tProp,
    agent,
    isPublished = false,
    sharedGroups = [],
    orgGroups = [],
    groupNames = null,
    onSetPersonal,
    onSetEntireOrg,
    onToggleGroup,
    confirmWidening = false,
    disabled = false,
    title = null,
    hint = null,
    className = '',
}) {
    const { t: tHook } = useTranslation();
    const t = tProp || tHook;
    const groups = Array.isArray(sharedGroups) ? sharedGroups : [];
    const mode = audienceModeOf({ isPublished, sharedGroups: groups });
    const nameOf = makeGroupNamer({ groupNames, orgGroups });
    const { choosePersonal, chooseOrg, toggleGroup, confirmDialog } = useAudienceActions({
        t, entity: agent, mode, sharedGroups: groups, nameOf, confirmWidening,
        onSetPersonal, onSetEntireOrg, onToggleGroup,
    });

    const [pickerOpen, setPickerOpen] = useState(false);
    const addRef = useRef(null);

    const rowStyle = (active) => ({
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 10,
        // A 1px border plus a 1px inset ring reads as the artboard's 2px ink
        // border without shifting the row by a pixel when it becomes active.
        border: `1px solid ${active ? 'var(--text-primary)' : 'var(--border-default)'}`,
        boxShadow: active ? 'inset 0 0 0 1px var(--text-primary)' : 'none',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontWeight: active ? 600 : 400,
        background: 'var(--bg-card)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        textAlign: 'left',
        width: '100%',
    });

    const onRowKey = (fn) => (e) => {
        if (disabled) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); }
    };

    const openPicker = () => { if (!disabled) setPickerOpen(true); };

    return (
        <div className={`flex flex-col gap-1.5 text-[13px] ${className}`} data-testid="audience-rows" data-mode={mode}>
            {title && <div className="font-semibold text-[var(--text-primary)]">{title}</div>}
            <div role="radiogroup" aria-label={t('visibility.aria_label', 'Visibility')} className="flex flex-col gap-1">
                <button
                    type="button"
                    role="radio"
                    aria-checked={mode === PERSONAL}
                    disabled={disabled}
                    onClick={choosePersonal}
                    data-audience-option={PERSONAL}
                    style={rowStyle(mode === PERSONAL)}
                >
                    <Lock size={13} aria-hidden="true" />
                    {t('visibility.personal', 'Personal')}
                </button>

                <button
                    type="button"
                    role="radio"
                    aria-checked={mode === ORG}
                    disabled={disabled}
                    onClick={chooseOrg}
                    data-audience-option={ORG}
                    style={rowStyle(mode === ORG)}
                >
                    <Building2 size={13} aria-hidden="true" />
                    {t('visibility.entire_org', 'Entire organisation')}
                </button>

                {/* A div, not a button: the chips and "+" inside are buttons of
                    their own, and buttons do not nest. */}
                <div
                    role="radio"
                    aria-checked={mode === GROUPS}
                    aria-disabled={disabled || undefined}
                    tabIndex={disabled ? -1 : 0}
                    onClick={openPicker}
                    onKeyDown={onRowKey(openPicker)}
                    data-audience-option={GROUPS}
                    style={rowStyle(mode === GROUPS)}
                >
                    <Users size={13} aria-hidden="true" />
                    {t('visibility.groups', 'Groups')}
                    <span className="ml-2 flex flex-wrap gap-1 font-medium" data-testid="audience-group-chips">
                        {groups.map(gid => {
                            const name = nameOf(gid);
                            const removeLabel = t('visibility.remove_group', 'Remove {name}', { name }).replace(/\{name\}/g, name);
                            return (
                                <button
                                    key={gid}
                                    type="button"
                                    disabled={disabled}
                                    aria-label={removeLabel}
                                    title={removeLabel}
                                    onClick={(e) => { e.stopPropagation(); toggleGroup(gid); }}
                                    className="inline-flex items-center gap-1 leading-5 hover:opacity-80 disabled:opacity-50"
                                    style={{ padding: '0 7px', borderRadius: 999, background: 'var(--bg-tertiary)', color: 'var(--text-primary)' }}
                                >
                                    {name}
                                    <X size={11} aria-hidden="true" style={{ color: 'var(--text-tertiary)' }} />
                                </button>
                            );
                        })}
                        <button
                            ref={addRef}
                            type="button"
                            disabled={disabled}
                            aria-label={t('visibility.add_group', 'Add group')}
                            title={t('visibility.add_group', 'Add group')}
                            aria-haspopup="dialog"
                            aria-expanded={pickerOpen}
                            onClick={(e) => { e.stopPropagation(); openPicker(); }}
                            className="inline-flex items-center leading-5 hover:opacity-80 disabled:opacity-50"
                            style={{ padding: '0 7px', borderRadius: 999, border: '1px dashed var(--border-default)', color: 'var(--text-tertiary)', background: 'transparent' }}
                        >
                            <Plus size={11} aria-hidden="true" />
                        </button>
                    </span>
                </div>
            </div>

            {hint && (
                <div className="text-xs text-[var(--text-tertiary)]" style={{ lineHeight: '16px' }}>{hint}</div>
            )}

            <AnchoredMenu
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                anchorRef={addRef}
                align="left"
                minWidth={240}
                role="dialog"
                aria-label={t('visibility.or_specific_groups', 'Or specific groups')}
                data-testid="audience-group-picker"
                style={{ background: 'var(--bg-card)', borderRadius: 12 }}
            >
                <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-[var(--text-tertiary)] border-b border-[var(--border-default)]">
                    {t('visibility.or_specific_groups', 'Or specific groups')}
                </div>
                <GroupChecklist t={t} orgGroups={orgGroups} sharedGroups={groups} onToggle={toggleGroup} disabled={disabled} />
            </AnchoredMenu>

            {confirmDialog}
        </div>
    );
}
