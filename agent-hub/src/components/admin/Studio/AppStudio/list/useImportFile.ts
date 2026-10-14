import { type ChangeEvent, useCallback, useEffect, useState } from 'react';
import type { StudioApp } from './types';
import useTranslation from '../../../../../hooks/useTranslation';
import toast from '../../../../shared/Toast';
import { studioAppsApi } from '../studioAppsApi';

/**
 * The Import tab's own little state machine: a file, what it claims, the
 * reason the last attempt failed, and whether one is in flight. Pulled out
 * of NewAppModal so its nine statements are one line there instead — the
 * modal already carries the blank/template tabs on top of this one.
 *
 * `onTemplateImported` is NewAppModal's business (refetch the gallery, switch
 * tabs) and stays a callback rather than something this hook decides; a
 * TEMPLATE produced a template, so the result is shown where templates live.
 * An APP ARCHIVE produced a working app, so `onCreated` is the same prop
 * NewAppModal uses for every other way of getting one.
 */
interface UseImportFileOptions {
    open: boolean;
    name: string;
    onCreated: (app: StudioApp) => void;
    onTemplateImported: () => void;
}

/** A refusal from the studio-apps API: the message, plus the server's reasons when it named them. */
type ImportError = { message?: string; body?: { details?: unknown } } | null | undefined;

function useImportFile({ open, name, onCreated, onTemplateImported }: UseImportFileOptions) {
    const { t } = useTranslation();
    const [file, setFile] = useState<File | null>(null);
    const [envelope, setEnvelope] = useState<unknown>(null);
    const [error, setError] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);

    // Reset per open so a re-opened modal starts fresh.
    useEffect(() => {
        if (!open) return;
        setFile(null);
        setEnvelope(null);
        setError(null);
        setImporting(false);
    }, [open]);

    // Reading the file is the one step that can fail before there is anything
    // to show, so it is separated from the import itself — a file that is not
    // JSON is answered here, in a sentence, rather than by the server.
    const pick = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
        const picked = event.target.files?.[0];
        event.target.value = '';            // so the same file can be picked twice
        if (!picked) return;
        setError(null);
        try {
            const parsed = JSON.parse(await picked.text());
            setFile(picked);
            setEnvelope(parsed);
        } catch {
            setFile(null);
            setEnvelope(null);
            setError(t('studio_apps_bi.list.import_not_json', 'That file is not a template file — it is not readable JSON.'));
        }
    }, [t]);

    const clear = useCallback(() => {
        setFile(null);
        setEnvelope(null);
        setError(null);
    }, []);

    // Warnings here are things that did NOT arrive — a refused file, a dropped
    // column. Reported over the success rather than under it, because "app
    // imported" plus a missing drawing reads as a broken app when nobody said
    // a drawing went missing.
    const importArchiveFile = useCallback(async (env: unknown, trimmedName: string) => {
        const res = await studioAppsApi.importApp(env, trimmedName ? { name: trimmedName } : {});
        const app = res?.app;
        if (!app?.id) throw new Error(t('studio_apps_bi.list.import_no_app', 'The import returned no app.'));
        const installed = res?.report?.installed || {};
        const warnings = res?.warnings || [];
        const what = t('studio_apps_bi.list.import_what', '{rows} rows and {files} files', { rows: installed.rows || 0, files: installed.files || 0 });
        if (warnings.length) toast.error(t('studio_apps_bi.list.import_app_warnings', 'App imported with {what}, but: {warnings}', { what, warnings: warnings.slice(0, 2).join(' ') }));
        else toast.success(t('studio_apps_bi.list.import_app_done', 'App imported with {what}.', { what }));
        clear();
        onCreated(app);
    }, [clear, onCreated, t]);

    const importTemplateFile = useCallback(async (env: unknown, trimmedName: string) => {
        const res = await studioAppsApi.importTemplate(env, trimmedName ? { title: trimmedName } : {});
        const warnings = res?.warnings || [];
        if (warnings.length) toast.success(t('studio_apps_bi.list.import_template_warnings', 'Template imported. {warnings}', { warnings: warnings.slice(0, 2).join(' ') }));
        else toast.success(t('studio_apps_bi.list.import_template_done', 'Template imported — it is in your gallery.'));
        clear();
        onTemplateImported();
    }, [clear, onTemplateImported, t]);

    /**
     * Post the file, to whichever of the two doors it is for.
     */
    const run = useCallback(async () => {
        if (!envelope || importing) return;
        const isArchive = (envelope as { format?: unknown }).format === 'beeflow.app';
        setImporting(true);
        setError(null);
        try {
            const trimmed = name.trim();
            if (isArchive) await importArchiveFile(envelope, trimmed);
            else await importTemplateFile(envelope, trimmed);
        } catch (caught) {
            const err = caught as ImportError;
            // The server names each reason it refused; a bare "invalid" would
            // leave the only person who can fix the file with nothing to go on.
            const details = err?.body?.details;
            setError(Array.isArray(details) && details.length
                ? t('studio_apps_bi.list.import_error_details', '{message}: {details}', { message: err?.message, details: details.slice(0, 3).join('; ') })
                : (err?.message || (isArchive
                    ? t('studio_apps_bi.list.import_failed_app', 'Could not import the app.')
                    : t('studio_apps_bi.list.import_failed_template', 'Could not import the template.'))));
        } finally {
            setImporting(false);
        }
    }, [envelope, importing, name, importArchiveFile, importTemplateFile, t]);

    return { file, envelope, error, importing, pick, clear, run };
}

export default useImportFile;
