import React from 'react';
import { Select } from './settingsPrimitives';
import { useTranslation } from '@/hooks/useTranslation';

/**
 * The organisation's third state for a meeting-notes setting, shared by the
 * Talk, Google Meet and Teams admin panels.
 *
 * On the org document `null` means "no opinion: each member decides"
 * (resolveTalkNotesSettings / resolveGmeetNotesSettings /
 * resolveTeamsNotesSettings read their own value then). Any concrete value,
 * `false` included, overrides every member. The panels PUT the whole form, so
 * a field they cannot show as null is written as a concrete value on the
 * first save and silently pins every member: an admin who changed only the
 * language switched auto-import off for everyone.
 */

/** The select value for "each member decides"; the panels send `null` for it. */
const INHERIT = '';

/**
 * The form an org panel starts from, built from the GET answer.
 *
 * Before the org's first save the server answers its built-in defaults
 * (`{ ...DEFAULTS, ...stored }` with nothing stored), which are not an
 * opinion of the org: those fields start as `null`. A saved document always
 * carries `updatedAt`, and then its values are used as stored, nulls included.
 */
export function orgFormFromAnswer<T extends object>(data: Partial<T> | null | undefined, inheritable: readonly (keyof T)[]): Partial<T> {
    if (!data) return {};
    const stamp = (data as { updatedAt?: unknown }).updatedAt;
    if (stamp !== undefined && stamp !== null && stamp !== '') return { ...data };
    const form: Partial<T> = { ...data };
    for (const key of inheritable) (form as Record<keyof T, unknown>)[key] = null;
    return form;
}

/** A select value back to the stored value: "each member decides" is null. */
function fromChoice(value: string): string | null {
    return value === INHERIT ? null : value;
}

interface InheritSelectProps {
    ariaLabel: string;
    value: string | null | undefined;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string | null) => void;
    disabled?: boolean;
}

/** A choice with "Each member decides" first; picking it stores null. */
export function InheritSelect({ ariaLabel, value, options, onChange, disabled }: InheritSelectProps) {
    const { t } = useTranslation();
    return (
        <Select
            ariaLabel={ariaLabel} value={value ?? INHERIT} disabled={disabled}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(fromChoice(e.target.value))}
            options={[{ value: INHERIT, label: t('meetings.admin_org.member_decides', 'Each member decides') }, ...options]}
        />
    );
}

interface InheritSwitchProps {
    ariaLabel: string;
    value: boolean | null | undefined;
    onChange: (value: boolean | null) => void;
    disabled?: boolean;
}

/** An on/off setting with a third state, "Each member decides" (null). */
export function InheritSwitch({ ariaLabel, value, onChange, disabled }: InheritSwitchProps) {
    const { t } = useTranslation();
    const current = value === true ? 'on' : value === false ? 'off' : null;
    return (
        <InheritSelect
            ariaLabel={ariaLabel} value={current} disabled={disabled}
            onChange={(v) => onChange(v === null ? null : v === 'on')}
            options={[{ value: 'on', label: t('common.on', 'On') }, { value: 'off', label: t('common.off', 'Off') }]}
        />
    );
}

/** The line under each panel's intro that says what the third state does. */
export function InheritHint() {
    const { t } = useTranslation();
    return (
        <p className="text-[12px] mb-3 text-[var(--text-muted)]">
            {t('meetings.admin_org.inherit_hint', 'A setting on “Each member decides” follows each member’s own choice in their Preferences. Any other value applies to every member.')}
        </p>
    );
}

/** Shown instead of the form when the org settings could not be read: a save would overwrite them. */
export function OrgSettingsLoadError() {
    const { t } = useTranslation();
    return (
        <div role="alert" className="px-5 py-4 rounded-xl border text-[13px] bg-[var(--bg-secondary)] border-[var(--border-subtle)] text-[var(--error-ink)]">
            {t('meetings.admin_org.load_failed', 'The organisation settings could not be loaded. Reload the page before you change them.')}
        </div>
    );
}
