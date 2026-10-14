import { Loader2, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { filePreview, saveJsonFile } from './importExport';
import ImportPanel from './ImportPanel';
import TemplateGallery from './TemplateGallery';
import type { OpenOptions, StudioApp, StudioTemplate } from './types';
import useImportFile from './useImportFile';
import useTranslation from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import Tabs from '../../../../shared/Tabs';
import toast from '../../../../shared/Toast';
import { studioAppsApi } from '../studioAppsApi';

// ── New-app modal ───────────────────────────────────────────────────


// A failed template fetch leaves `templates` null, which is the very condition
// the load effect fires on — so the attempt count, not the state, is what ends
// the loop. One silent retry covers a blip; after that the error state with
// "Try again" takes over.
const MAX_TEMPLATE_ATTEMPTS = 2;

interface NewAppModalProps {
    open: boolean;
    onClose: () => void;
    onCreated: (app: StudioApp, openOptions?: OpenOptions) => void;
}

/** What a failed studio-apps call carries; only its message is shown. */
type ApiError = { message?: string } | null | undefined;

function NewAppModal({ open, onClose, onCreated }: NewAppModalProps) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<'blank' | 'template' | 'import'>('blank');
    const [name, setName] = useState('');
    const [creating, setCreating] = useState(false);
    const [creatingTemplateId, setCreatingTemplateId] = useState<string | null>(null);
    const [remixingTemplateId, setRemixingTemplateId] = useState<string | null>(null);
    const [deletingTemplateId, setDeletingTemplateId] = useState<string | null>(null);
    const [exportingTemplateId, setExportingTemplateId] = useState<string | null>(null);
    const [templates, setTemplates] = useState<StudioTemplate[] | null>(null);
    const [templatesLoading, setTemplatesLoading] = useState(false);
    const [templatesError, setTemplatesError] = useState<string | null>(null);

    // Reset per open so a re-opened modal starts fresh.
    useEffect(() => {
        if (!open) return;
        setTab('blank');
        setName('');
        setCreating(false);
        setCreatingTemplateId(null);
        setRemixingTemplateId(null);
        setDeletingTemplateId(null);
        setExportingTemplateId(null);
    }, [open]);

    const templateAttemptsRef = useRef(0);

    const loadTemplates = useCallback(async () => {
        templateAttemptsRef.current += 1;
        setTemplatesLoading(true);
        setTemplatesError(null);
        try {
            const res = await studioAppsApi.listTemplates();
            setTemplates(res?.templates || []);
        } catch (err) {
            setTemplatesError((err as ApiError)?.message || t('studio_apps_bi.list.templates_load_failed', 'Could not load templates.'));
        } finally {
            setTemplatesLoading(false);
        }
    }, [t]);

    /**
     * Delete an org-captured template. Removed from the list optimistically
     * only AFTER the server confirms — a template that reappears on the next
     * open would read as a broken button, and this is not a hot path.
     */
    const deleteTemplate = useCallback(async (tpl: StudioTemplate) => {
        if (!tpl?.id) return;
        setDeletingTemplateId(tpl.id);
        try {
            await studioAppsApi.deleteTemplate(tpl.id);
            setTemplates((prev) => (prev || []).filter((x) => x.id !== tpl.id));
            toast.success(t('studio_apps_bi.list.template_deleted', 'Template "{title}" deleted', { title: tpl.title }));
        } catch (err) {
            toast.error((err as ApiError)?.message || t('studio_apps_bi.list.template_delete_failed', 'Could not delete the template'));
        } finally {
            setDeletingTemplateId(null);
        }
    }, [t]);

    // A deliberate user retry starts the budget over.
    const retryTemplates = useCallback(() => {
        templateAttemptsRef.current = 0;
        loadTemplates();
    }, [loadTemplates]);

    // Fetch the gallery once per modal lifetime (templates are static).
    useEffect(() => {
        if (!open || templates !== null || templatesLoading) return;
        if (templateAttemptsRef.current >= MAX_TEMPLATE_ATTEMPTS) return;
        loadTemplates();
    }, [open, templates, templatesLoading, loadTemplates]);

    // `openOptions` (optional) rides through onCreated → the editor open, so a
    // remix can ask the shell to focus the AI builder with a prefilled prompt.
    const create = useCallback(async (body: Record<string, unknown>, setBusy: (busy: boolean) => void, openOptions?: OpenOptions) => {
        setBusy(true);
        try {
            const res = await studioAppsApi.createApp(body);
            const app = res?.app;
            if (!app?.id) throw new Error(t('studio_apps_bi.list.create_no_app', 'Create returned no app'));
            // A data-backed template installs tables, seed rows and connectors
            // AFTER the app row exists, and that half can fail on its own. It
            // used to fail silently, leaving an app with every screen and no
            // data behind them — which reads as a broken template rather than a
            // failed step. Say it, and keep the app: the screens are still there
            // and the data can be installed again.
            if (res?.dataInstall && res.dataInstall.ok === false) {
                toast.error(t('studio_apps_bi.list.create_data_failed', 'App created, but its tables and connections did not install: {error}', { error: res.dataInstall.error }));
            } else {
                toast.success(t('studio_apps_bi.list.created', 'App created.'));
            }
            onCreated(app, openOptions);
        } catch (err) {
            toast.error((err as ApiError)?.message || t('studio_apps_bi.list.create_failed', 'Could not create the app.'));
            setBusy(false);
        }
    }, [onCreated, t]);

    const busy = creating || !!creatingTemplateId || !!remixingTemplateId;

    const handleCreateBlank = (e: React.FormEvent) => {
        e.preventDefault();
        if (busy) return;
        const trimmed = name.trim();
        create(trimmed ? { name: trimmed } : {}, setCreating);
    };

    const handlePickTemplate = (tpl: StudioTemplate) => {
        if (busy) return;
        const trimmed = name.trim();
        create(
            trimmed ? { templateId: tpl.id, name: trimmed } : { templateId: tpl.id },
            (b: boolean) => setCreatingTemplateId(b ? tpl.id : null),
        );
    };

    // Remix = create from the template, then open the editor with the AI builder
    // focused and a prefilled prompt. The builder consumes context.templateId
    // (the AI sibling wave) so it can adapt the just-installed app.
    const handleRemixTemplate = (tpl: StudioTemplate) => {
        if (busy) return;
        const trimmed = name.trim();
        const prompt = t('studio_apps_bi.list.remix_prompt', 'Help me remix the "{title}" template. {description} I want to adapt it to my needs — suggest what to change and build it with me.', { title: tpl.title, description: tpl.description || '' });
        create(
            trimmed ? { templateId: tpl.id, name: trimmed } : { templateId: tpl.id },
            (b: boolean) => setRemixingTemplateId(b ? tpl.id : null),
            { remix: true, templateId: tpl.id, prompt: prompt.trim() },
        );
    };

    /**
     * Write a gallery template out to a file.
     *
     * The server's warnings are shown rather than swallowed: "3 automation
     * references removed" is the difference between a recipient who knows to
     * wire their own automation and one who finds out when a button does nothing.
     */
    const exportTemplate = useCallback(async (tpl: StudioTemplate) => {
        if (exportingTemplateId) return;
        setExportingTemplateId(tpl.id);
        try {
            const res = await studioAppsApi.exportTemplate(tpl.id);
            if (!res?.envelope) throw new Error(t('studio_apps_bi.list.export_empty', 'The export came back empty.'));
            saveJsonFile(res.filename || 'app-template.beeflow-app.json', res.envelope);
            const warnings = res.warnings || [];
            if (warnings.length) toast.success(t('studio_apps_bi.list.export_warnings', 'Template exported. {warnings}', { warnings: warnings.join(' ') }));
            else toast.success(t('studio_apps_bi.list.exported', 'Template exported.'));
        } catch (err) {
            toast.error((err as ApiError)?.message || t('studio_apps_bi.list.export_failed', 'Could not export the template.'));
        } finally {
            setExportingTemplateId(null);
        }
    }, [exportingTemplateId, t]);

    const importState = useImportFile({
        open, name, onCreated,
        onTemplateImported: () => { setTemplates(null); templateAttemptsRef.current = 0; setTab('template'); },
    });

    return (
        <Modal
            open={open}
            onClose={() => { if (!busy) onClose(); }}
            title={t('studio_apps_bi.list.new_app', 'New app')}
            description={t('studio_apps_bi.list.new_app_desc', 'Start from scratch or pick a template — the AI can build the rest with you.')}
            size="lg"
        >
            <Tabs
                value={tab}
                onChange={setTab}
                ariaLabel={t('studio_apps_bi.list.how_to_start', 'How to start')}
                size="sm"
                className="mb-4"
                items={[
                    { id: 'blank', label: t('studio_apps_bi.list.tab_blank', 'Start blank') },
                    { id: 'template', label: t('studio_apps_bi.list.tab_template', 'From template') },
                    { id: 'import', label: t('studio_apps_bi.list.tab_import', 'From a file') },
                ]}
            />

            <div className="mb-4">
                <label className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">
                    {tab === 'blank' ? t('studio_apps_bi.list.name', 'Name')
                        : tab === 'import' ? t('studio_apps_bi.list.name_import', 'Name (optional — renames the imported template)')
                            : t('studio_apps_bi.list.name_template', 'Name (optional — templates bring their own)')}
                </label>
                <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('studio_apps_bi.list.name_placeholder', 'e.g. Vacation requests')}
                    maxLength={120}
                    className="w-full px-3 py-2 text-sm rounded-lg border outline-none focus:ring-2"
                    style={{
                        borderColor: 'var(--border-subtle)',
                        background: 'var(--bg-primary)',
                        color: 'var(--text-primary)',
                    }}
                />
            </div>

            {tab === 'import' ? (
                <ImportPanel
                    file={importState.file}
                    preview={filePreview(importState.envelope, t)}
                    error={importState.error}
                    importing={importState.importing}
                    onPick={importState.pick}
                    onClear={importState.clear}
                    onImport={importState.run}
                />
            ) : tab === 'blank' ? (
                <form onSubmit={handleCreateBlank} className="flex justify-end">
                    <button
                        type="submit"
                        disabled={busy}
                        className="px-4 py-2 rounded-lg text-sm font-medium text-white flex items-center gap-1.5 disabled:opacity-50 bg-[var(--accent-primary)]"
                    >
                        {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
                        {t('studio_apps_bi.list.create_app', 'Create app')}
                    </button>
                </form>
            ) : (
                <TemplateGallery
                    templates={templates}
                    loading={templatesLoading}
                    error={templatesError}
                    creatingId={creatingTemplateId}
                    remixingId={remixingTemplateId}
                    deletingId={deletingTemplateId}
                    exportingId={exportingTemplateId}
                    onPick={handlePickTemplate}
                    onRemix={handleRemixTemplate}
                    onDelete={deleteTemplate}
                    onExport={exportTemplate}
                    onRetry={retryTemplates}
                />
            )}
        </Modal>
    );
}

export default NewAppModal;
