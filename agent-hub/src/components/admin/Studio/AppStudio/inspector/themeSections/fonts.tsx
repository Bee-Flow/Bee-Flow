import { Type } from 'lucide-react';
import { useState } from 'react';
import Button from '@/components/shared/Button';
import FormField from '@/components/shared/FormField';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { SectionTitle } from '../AiBrowsingSettings';
import AssetPicker from '../assets/AssetPicker';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import { isAssetRef } from '../../runtime/assets/assetUrl';
import { FONT_ROLE_FAMILIES, FONT_ROLES, fontRolesOf, type FontRole, type FontRoles } from '../../runtime/fonts/fontRoles';
import { updateDesign } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * Theme panel: "Fonts per role" — design.fonts (schema 3, runtime/fonts/fontRoles.ts). A
 * typeface for headings, body text and code: one of the families Bee Flow serves itself, or a
 * WOFF2 uploaded to the app. A role left on "As today" keeps the look the app has; with every
 * role on it the key is removed, so the app is what it was.
 */

const SELECT_CLS = 'w-full border px-2 py-1.5 text-sm outline-none focus:border-[var(--app-primary)] disabled:opacity-50 [background:var(--bg-primary)] [border-color:var(--border-default)]! [border-radius:6px] [color:var(--text-primary)]!';
const UPLOADED = '__uploaded__';

function roleLabels(t: TranslateFn): Record<FontRole, [string, string]> {
    return {
        heading: [t('studio_apps_lk17.role_heading', 'Headings'), t('studio_apps_lk17.role_heading_hint', 'Every heading of the app, and components set to the heading font.')],
        body: [t('studio_apps_lk17.role_body', 'Body text'), t('studio_apps_lk17.role_body_hint', 'All other text. Takes the place of the typeface above.')],
        mono: [t('studio_apps_lk17.role_mono', 'Code and numbers'), t('studio_apps_lk17.role_mono_hint', 'Code, and components set to the mono font.')],
    };
}

interface RoleFieldProps {
    role: FontRole;
    value: string | undefined;
    disabled: boolean;
    onChange: (value: string | null) => void;
    onUpload: () => void;
    canUpload: boolean;
}

function RoleField({ role, value, disabled, onChange, onUpload, canUpload }: RoleFieldProps) {
    const { t } = useTranslation();
    const [label, hint] = roleLabels(t)[role];
    const uploaded = isAssetRef(value);
    const selectValue = uploaded ? UPLOADED : (value ?? '');
    return (
        <FormField label={label} hint={hint}>
            <div className="flex items-center gap-1.5" data-font-role={role}>
                <select
                    value={selectValue}
                    onChange={(e) => onChange(e.target.value === UPLOADED ? value ?? null : e.target.value || null)}
                    disabled={disabled}
                    aria-label={label}
                    className={SELECT_CLS}
                >
                    <option value="">{t('studio_apps_lk17.as_today', 'As today')}</option>
                    {Object.entries(FONT_ROLE_FAMILIES).map(([id, { family }]) => (
                        <option key={id} value={id}>{family}</option>
                    ))}
                    {uploaded ? <option value={UPLOADED}>{t('studio_apps_lk17.uploaded', 'Uploaded font')}</option> : null}
                </select>
                <Button
                    size="sm"
                    variant="secondary"
                    icon={Type}
                    disabled={disabled || !canUpload}
                    onClick={onUpload}
                    aria-label={t('studio_apps_lk17.choose_uploaded', 'Choose an uploaded font')}
                    title={t('studio_apps_lk17.choose_uploaded', 'Choose an uploaded font')}
                />
            </div>
        </FormField>
    );
}

function FontsSection({ definition, onCommit, disabled }: ThemeSectionProps) {
    const { t } = useTranslation();
    const appId = useEditorChrome()?.appId ?? null;
    const [picking, setPicking] = useState<FontRole | null>(null);
    const roles: FontRoles = fontRolesOf(definition.design) || {};

    const commit = (role: FontRole, value: string | null) => {
        const next: FontRoles = { ...roles };
        if (value) next[role] = value;
        else delete next[role];
        const fonts = Object.keys(next).length ? next : null;
        if (!fonts && !Object.keys(roles).length) return;
        const def = updateDesign(definition, { fonts, preset: 'custom' });
        if (def !== definition) onCommit(def);
    };

    return (
        <div data-testid="app-font-roles">
            <SectionTitle>{t('studio_apps_lk17.title', 'Fonts per role')}</SectionTitle>
            <div className="flex flex-col gap-3">
                {FONT_ROLES.map((role) => (
                    <RoleField
                        key={role}
                        role={role}
                        value={roles[role]}
                        disabled={disabled}
                        canUpload={!!appId}
                        onChange={(value) => commit(role, value)}
                        onUpload={() => setPicking(role)}
                    />
                ))}
                <p className="text-[11px] text-[var(--text-secondary)]">{t('studio_apps_lk17.self_hosted', 'Every font is served by Bee Flow itself. An uploaded font is a WOFF2 file of this app.')}</p>
            </div>
            {/* Mounted only while open: the list is read when someone asks for it. */}
            {picking ? (
                <AssetPicker
                    open
                    onClose={() => setPicking(null)}
                    appId={appId}
                    definition={definition}
                    kind="font"
                    onPick={(ref) => { commit(picking, ref); setPicking(null); }}
                />
            ) : null}
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 30, Section: FontsSection };

export default entry;
