import { Copy, Download, Package, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { duplicateAutomationOnServer, invalidateAutomationTrash, restoreAutomation } from '../../../../api/queries/automation/library';
import { downloadAutomationExport, saveAsTemplate, trashAutomation } from '../../../../api/queries/automation/settings';
import { useBuilderConfirm } from '../BuilderConfirmContext';
import { LINK_BTN, SECONDARY_BTN } from './settingsUi';
import type { SettingsAutomation } from './settingsUi';

type ActionKey = 'duplicate' | 'export' | 'template' | 'delete';

interface Notice { tone: 'ok' | 'error'; text: string; copyId?: string; trashed?: boolean }

/**
 * Settings › General › Actions (artboard 5e-1): Duplicate · Export · Save as
 * template · Delete… Delete moves the automation to the trash (30 days, runs
 * stay) and offers Undo right here.
 */
export default function GeneralActions({ automation, onAutomationChange }: {
    automation: SettingsAutomation;
    onAutomationChange?: (next: SettingsAutomation) => void;
}) {
    const { t } = useTranslation();
    const confirm = useBuilderConfirm() as (opts: Record<string, unknown>) => Promise<boolean>;
    const [busy, setBusy] = useState<ActionKey | 'restore' | null>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const id = automation.id as string;
    const title = automation.title || '';
    // What the role allows (automation/access.js): trash is the owner's,
    // a template needs edit; duplicate and export only need view.
    const role = typeof automation.myRole === 'string' ? automation.myRole : 'owner';
    const allowed: Record<ActionKey, boolean> = {
        duplicate: true, export: true, template: role === 'owner' || role === 'edit', delete: role === 'owner',
    };

    const run = async (key: ActionKey | 'restore', work: () => Promise<Notice | null>) => {
        setBusy(key);
        setNotice(null);
        try { setNotice(await work()); } catch (e) { setNotice({ tone: 'error', text: (e as Error)?.message || String(e) }); }
        setBusy(null);
    };

    const actions: { key: ActionKey; icon: LucideIcon; title: string; hint: string; button: string; danger?: boolean; onClick: () => void }[] = [
        {
            key: 'duplicate', icon: Copy,
            title: t('automations.settings.action_duplicate', 'Duplicate'),
            hint: t('automations.settings.action_duplicate_hint', 'A copy as a draft, without runs'),
            button: t('automations.settings.action_duplicate', 'Duplicate'),
            onClick: () => run('duplicate', async () => {
                const copyId = await duplicateAutomationOnServer(id);
                return { tone: 'ok', text: t('automations.settings.duplicated', 'Copy created as a draft.'), copyId: copyId || undefined };
            }),
        },
        {
            key: 'export', icon: Download,
            title: t('automations.settings.action_export', 'Export'),
            hint: t('automations.settings.action_export_hint', 'A file to share or to import into another environment'),
            button: t('automations.settings.action_export', 'Export'),
            onClick: () => run('export', async () => {
                const warnings = await downloadAutomationExport(id, title);
                return warnings.length ? { tone: 'ok', text: warnings[0] } : null;
            }),
        },
        {
            key: 'template', icon: Package,
            title: t('automations.settings.action_template', 'Save as template'),
            hint: t('automations.settings.action_template_hint', 'Colleagues can start their own from it'),
            button: t('automations.settings.action_template_button', 'As template'),
            onClick: () => run('template', async () => {
                await saveAsTemplate(id, { title, description: automation.description || undefined });
                return { tone: 'ok', text: t('automations.settings.template_saved', 'Saved as a template for your organisation.') };
            }),
        },
        {
            key: 'delete', icon: Trash2, danger: true,
            title: t('automations.settings.action_delete', 'Delete'),
            hint: t('automations.settings.action_delete_hint', 'First 30 days in the trash; runs are kept'),
            button: t('automations.settings.action_delete_button', 'Delete…'),
            onClick: async () => {
                const ok = await confirm({
                    title: t('automations.settings.delete_confirm_title', 'Move this automation to the trash?'),
                    description: t('automations.settings.delete_confirm_body', 'It stops running. You can restore it from the trash for 30 days; its runs are kept.'),
                    confirmLabel: t('automations.settings.delete_confirm', 'Move to trash'),
                    destructive: true,
                });
                if (!ok) return;
                await run('delete', async () => {
                    const trashed = await trashAutomation(id);
                    invalidateAutomationTrash();
                    onAutomationChange?.({ ...automation, deletedAt: new Date().toISOString(), ...(trashed.automation || {}), isActive: false });
                    return { tone: 'ok', text: t('automations.settings.trashed', 'Moved to the trash.'), trashed: true };
                });
            },
        },
    ];

    return (
        <div className="flex flex-col gap-2 pt-1">
            <div className="text-[12px] font-semibold text-[var(--text-secondary)]">{t('automations.settings.actions', 'Actions')}</div>
            <ul className="rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] divide-y divide-[var(--border-default)]">
                {actions.filter((a) => allowed[a.key]).map((a) => (
                    <li key={a.key} className="flex items-center gap-3 px-3.5 py-2.5 text-[12px]">
                        <a.icon size={14} className={a.danger ? 'text-[var(--error)] shrink-0' : 'text-[var(--text-secondary)] shrink-0'} />
                        <div className="flex-1 min-w-0">
                            <div className="font-semibold text-[var(--text-primary)]">{a.title}</div>
                            <div className="text-[var(--text-tertiary)]">{a.hint}</div>
                        </div>
                        <button
                            type="button"
                            onClick={a.onClick}
                            disabled={busy !== null}
                            className={a.danger ? `${SECONDARY_BTN} text-[var(--error)]` : SECONDARY_BTN}
                        >
                            {a.button}
                        </button>
                    </li>
                ))}
            </ul>
            {notice && (
                <div role={notice.tone === 'error' ? 'alert' : 'status'} className={`flex items-center gap-2 text-[12px] ${notice.tone === 'error' ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'}`}>
                    <span>{notice.text}</span>
                    {notice.copyId && (
                        <a className={LINK_BTN} href={`/app/studio/automations/${encodeURIComponent(notice.copyId)}`}>
                            {t('automations.settings.open_copy', 'Open the copy')}
                        </a>
                    )}
                    {notice.trashed && (
                        <button
                            type="button"
                            className={LINK_BTN}
                            disabled={busy !== null}
                            onClick={() => run('restore', async () => {
                                await restoreAutomation(id);
                                invalidateAutomationTrash();
                                // Always restored paused (POST /:id/restore).
                                onAutomationChange?.({ ...automation, deletedAt: null, isActive: false });
                                return { tone: 'ok', text: t('automations.settings.restored', 'Restored.') };
                            })}
                        >
                            {t('automations.settings.undo', 'Undo')}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
