/**
 * The header's two menus: the "View as ▾" capsule (folds away below @4xl —
 * the ⋯ menu, which is always mounted, carries the same choice) and the ⋯
 * menu itself (⌘K, version history, "View as role…"). Both are AnchoredMenu
 * — portalled, so the center column's overflow clip can never cut them off.
 */
import { ChevronDown, Command, Eye, History, MoreHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import type { DefinitionRole } from './useCommandActions';
import useTranslation from '../../../../../../hooks/useTranslation';
import { isMac, modKeyLabel } from '../../../../../../utils/platform';
import AnchoredMenu from '../../../../../shared/AnchoredMenu';

interface MoreMenuItemProps {
    icon: LucideIcon;
    label: string;
    hint?: string | null;
    disabled?: boolean;
    onClick: () => void;
}

/** One row of the ⋯ menu. */
function MoreMenuItem({ icon, label, hint = null, disabled = false, onClick }: MoreMenuItemProps) {
    const Icon = icon;
    return (
        <button
            type="button"
            role="menuitem"
            disabled={disabled}
            onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 text-[var(--text-primary)]"
        >
            <Icon className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <span className="flex-1">{label}</span>
            {hint ? (
                <span className="text-[11px] text-[var(--text-tertiary)]">{hint}</span>
            ) : null}
        </button>
    );
}

/** One role in the View-as menu — a radio-style item, the current one checked. */
function RoleMenuItem({ label, checked, onClick }: { label: string; checked: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            onClick={onClick}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
        >
            <span
                aria-hidden="true"
                className="h-2 w-2 shrink-0 rounded-full"
                style={{ background: checked ? 'var(--accent-primary)' : 'transparent', boxShadow: checked ? 'none' : 'inset 0 0 0 1.5px var(--text-tertiary)' }}
            />
            <span className="flex-1">{label}</span>
        </button>
    );
}

interface ViewAsMenuProps {
    roles: DefinitionRole[];
    previewRole: string | null;
    previewRoleName: string | null;
    setPreviewRole: (roleKey: string | null) => void;
}

/** View as role — a capsule that opens a menu. */
export function ViewAsMenu({ roles, previewRole, previewRoleName, setPreviewRole }: ViewAsMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const ownerLabel = t('app_studio.header.view_as_owner', 'Owner');
    return (
        <>
            <button
                type="button"
                ref={anchorRef}
                onClick={() => setOpen((o) => !o)}
                aria-label={t('app_studio.header.view_as_aria', 'View as role')}
                aria-haspopup="menu"
                aria-expanded={open}
                title={t('app_studio.header.view_as_title', 'Preview which screens and components a role sees')}
                data-testid="view-as-capsule"
                className="inline-flex h-8 shrink-0 items-center gap-2 whitespace-nowrap rounded-[10px] border px-3 text-xs hover:bg-[var(--bg-tertiary)] @max-4xl/edhead:hidden"
                style={{
                    borderColor: previewRole ? 'var(--accent-primary)' : 'var(--border-default)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-primary)',
                }}
            >
                <Eye className="h-3.5 w-3.5 shrink-0" style={{ color: previewRole ? 'var(--accent-primary)' : 'var(--text-tertiary)' }} aria-hidden="true" />
                <span className="@max-6xl/edhead:hidden text-[var(--text-secondary)]">{t('app_studio.header.view_as', 'View as')}</span>
                <span className="font-semibold">{previewRoleName || ownerLabel}</span>
                <ChevronDown className="h-3 w-3 text-[var(--text-tertiary)]" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                role="menu"
                minWidth={220}
                className="py-1"
                style={{ background: 'var(--bg-secondary)' }}
            >
                <RoleMenuItem
                    label={t('app_studio.header.view_as_owner_full', 'Owner (full view)')}
                    checked={!previewRole}
                    onClick={() => { setOpen(false); setPreviewRole(null); }}
                />
                {roles.map((r) => (
                    <RoleMenuItem
                        key={r.id}
                        label={r.name || r.id}
                        checked={previewRole === r.id}
                        onClick={() => { setOpen(false); setPreviewRole(r.id); }}
                    />
                ))}
            </AnchoredMenu>
        </>
    );
}

interface MoreMenuProps {
    streamLock: boolean;
    onOpenCommand: () => void;
    onOpenVersions: () => void;
}

/** ⋯ — ⌘K, version history, view-as at narrow widths. */
export function MoreMenu({ streamLock, onOpenCommand, onOpenVersions }: MoreMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const anchorRef = useRef<HTMLButtonElement>(null);
    const paletteShortcut = isMac() ? `${modKeyLabel()}K` : `${modKeyLabel()}+K`;
    return (
        <>
            <button
                type="button"
                ref={anchorRef}
                onClick={() => setOpen((o) => !o)}
                aria-label={t('app_studio.header.more', 'More')}
                title={t('app_studio.header.more', 'More')}
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
            >
                <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="right"
                role="menu"
                minWidth={230}
                className="py-1"
                style={{ background: 'var(--bg-secondary)' }}
            >
                <MoreMenuItem
                    icon={Command}
                    label={t('app_studio.header.command_palette', 'Command palette')}
                    hint={paletteShortcut}
                    onClick={() => { setOpen(false); onOpenCommand(); }}
                />
                <MoreMenuItem
                    icon={History}
                    label={t('app_studio.header.version_history', 'Version history')}
                    disabled={streamLock}
                    onClick={() => { setOpen(false); onOpenVersions(); }}
                />
                {/* Not an embedded <select>: role="menu" allows only menu items,
                    and the command palette already lists a "Preview as" action
                    for the owner view and every role. */}
                <MoreMenuItem
                    icon={Eye}
                    label={t('app_studio.header.view_as_menu', 'View as role…')}
                    onClick={() => { setOpen(false); onOpenCommand(); }}
                />
            </AnchoredMenu>
        </>
    );
}
