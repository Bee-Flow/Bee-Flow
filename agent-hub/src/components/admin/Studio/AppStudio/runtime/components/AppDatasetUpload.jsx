import { Dna, Loader2, UploadCloud, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../../utils/helpers';
import { useDataContext } from '../DataContext';
import { useFormField } from '../formContext';
import { useRuntime } from '../RuntimeContext';
import { Field } from '../uiBits';
import useInputChange from '../useInputChange';
import useDatasetUpload from '../useDatasetUpload';

/**
 * App Studio runtime — 'input_dataset'. Spec: server/appStudio/componentSpecs.js.
 *
 * Picks or uploads a LARGE dataset (a multi-GB genome VCF). The upload streams
 * in resumable 32 MB parts (useDatasetUpload); the server then INGESTS the file
 * in the background (validate + re-encode + index), which this component polls.
 * The field value is a dataset DESCRIPTOR
 *   { kind: 'studio_dataset', datasetId, name, build }
 * — the shape dataset_query steps and the AI steps' `datasets` binding accept.
 * The value lands (and onChange fires) only when the dataset reaches 'ready':
 * a dataset that is still indexing cannot be queried yet.
 *
 * The list and the status poll read /api/studio-apps/:id/large-datasets
 * (routes/studioAppDatasets.js); /:id/datasets is the BI saved datasets.
 */

const POLL_MS = 2000;

function pctLabel(p) {
    return Number.isFinite(p) ? `${p}%` : '…';
}

export default function AppDatasetUpload({ node }) {
    const { t } = useTranslation();
    const { mode } = useRuntime();
    const { appId } = useDataContext();
    const { name, label = t('studio_apps_runtime.dataset_upload.label', 'Genome file'), required = false, buttonLabel = null, allowExisting = true } = node.props || {};
    const { value, setValue, error } = useFormField({ name, defaultValue: null, required, label });
    const fireChange = useInputChange(node, name);
    const id = `${node.id}-input`;
    const live = mode === 'run' && !!appId;

    const [existing, setExisting] = useState([]);
    const [phase, setPhase] = useState('idle'); // idle | uploading | ingesting
    const [progress, setProgress] = useState(null); // { pct, note }
    const [uploadError, setUploadError] = useState(null);
    const pollRef = useRef(null);
    const aliveRef = useRef(true);

    const { upload, abort } = useDatasetUpload(appId);

    useEffect(() => () => {
        aliveRef.current = false;
        if (pollRef.current) clearTimeout(pollRef.current);
        abort();
    }, [abort]);

    const refreshExisting = useCallback(async () => {
        if (!live || !allowExisting) return;
        try {
            const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/large-datasets`);
            const data = await res.json().catch(() => ({}));
            if (res.ok && Array.isArray(data.datasets)) {
                setExisting(data.datasets.filter((d) => d.status === 'ready'));
            }
        } catch { /* the picker just stays empty */ }
    }, [appId, live, allowExisting]);

    useEffect(() => { refreshExisting(); }, [refreshExisting]);

    const commit = useCallback((ds) => {
        const descriptor = ds ? { kind: 'studio_dataset', datasetId: ds.id, name: ds.name, build: ds.build || null } : null;
        setValue(descriptor);
        fireChange(descriptor);
    }, [setValue, fireChange]);

    const pollUntilReady = useCallback((datasetId) => {
        const tick = async () => {
            if (!aliveRef.current) return;
            try {
                const res = await authFetch(`${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/large-datasets/${encodeURIComponent(datasetId)}`);
                const ds = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(ds.error || t('studio_apps_runtime.dataset_upload.status_check_failed', 'status check failed'));
                if (ds.status === 'ready') {
                    setPhase('idle');
                    setProgress(null);
                    commit(ds);
                    refreshExisting();
                    return;
                }
                if (ds.status === 'failed') {
                    setPhase('idle');
                    setProgress(null);
                    setUploadError(ds.error || t('studio_apps_runtime.dataset_upload.index_failed', 'The file could not be indexed.'));
                    return;
                }
                setProgress({ pct: ds.progressPct, note: ds.progressNote || 'indexing' });
            } catch { /* transient — keep polling */ }
            pollRef.current = setTimeout(tick, POLL_MS);
        };
        tick();
    }, [appId, commit, refreshExisting, t]);

    const handleFile = async (file) => {
        if (!live || !file) return;
        setUploadError(null);
        setPhase('uploading');
        setProgress({ pct: 0, note: 'uploading' });
        try {
            const datasetId = await upload(file, {
                onProgress: (pct) => setProgress({ pct, note: 'uploading' }),
            });
            setPhase('ingesting');
            setProgress({ pct: 0, note: 'indexing' });
            pollUntilReady(datasetId);
        } catch (err) {
            setPhase('idle');
            setProgress(null);
            setUploadError(err.message || t('studio_apps_runtime.dataset_upload.upload_failed', 'Upload failed.'));
        }
    };

    const busy = phase !== 'idle';
    const selected = value && typeof value === 'object' ? value : null;

    return (
        <Field id={id} label={label} required={required} error={error || uploadError}>
            <div className="flex flex-col gap-2">
                {allowExisting && existing.length > 0 && !busy ? (
                    <select
                        aria-label={t('studio_apps_runtime.dataset_upload.pick_existing', '{label} — pick an existing dataset', { label })}
                        value={selected?.datasetId || ''}
                        onChange={(e) => {
                            const ds = existing.find((d) => d.id === e.target.value);
                            commit(ds || null);
                        }}
                        className="px-3 py-2 text-sm border outline-none"
                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)' }}
                    >
                        <option value="">{t('studio_apps_runtime.dataset_upload.pick', 'Pick a dataset…')}</option>
                        {existing.map((d) => (
                            <option key={d.id} value={d.id}>
                                {d.name}{d.build ? ` (${d.build})` : ''}{d.variantCount ? ` — ${t('studio_apps_runtime.dataset_upload.variants', '{n} variants', { n: Number(d.variantCount).toLocaleString() })}` : ''}
                            </option>
                        ))}
                    </select>
                ) : null}

                <label
                    className="relative inline-flex w-fit items-center gap-2 px-3 py-1.5 text-sm cursor-pointer border focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-[var(--text-secondary)]"
                    style={{ background: 'var(--bg-card)', borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)', color: 'var(--text-primary)', opacity: live || mode !== 'run' ? undefined : 0.6 }}
                >
                    {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <UploadCloud className="w-3.5 h-3.5" aria-hidden="true" />}
                    <span>
                        {phase === 'uploading' ? t('studio_apps_runtime.dataset_upload.uploading', 'Uploading… {pct}', { pct: pctLabel(progress?.pct) })
                            : phase === 'ingesting' ? t('studio_apps_runtime.dataset_upload.indexing', 'Indexing… {pct} {note}', {
                                pct: progress?.pct != null ? pctLabel(progress.pct) : '',
                                note: progress?.note || '',
                            }).trim()
                                : (buttonLabel || t('studio_apps_runtime.dataset_upload.button', 'Upload a genome file (.vcf / .vcf.gz)'))}
                    </span>
                    <input
                        id={id}
                        name={name}
                        type="file"
                        accept=".vcf,.vcf.gz,.gz,text/plain,application/gzip"
                        aria-required={required || undefined}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={(error || uploadError) ? `${id}-error` : undefined}
                        className="absolute h-px w-px opacity-0"
                        disabled={busy || !live}
                        onChange={(e) => {
                            const picked = e.target.files?.[0] || null;
                            e.target.value = '';
                            handleFile(picked);
                        }}
                    />
                </label>

                {selected && !busy ? (
                    <div
                        className="flex items-center gap-2 p-1.5 text-xs border w-fit"
                        style={{ background: 'var(--bg-tertiary)', borderColor: 'var(--border-default)', borderRadius: 'var(--app-radius)' }}
                    >
                        <Dna className="w-3.5 h-3.5 shrink-0" aria-hidden="true" style={{ color: 'var(--app-primary)' }} />
                        <span className="truncate" style={{ color: 'var(--text-primary)' }}>
                            {selected.name}{selected.build ? ` · ${selected.build}` : ''}
                        </span>
                        <button
                            type="button"
                            onClick={() => commit(null)}
                            aria-label={t('studio_apps_runtime.dataset_upload.clear', 'Clear {name}', { name: selected.name })}
                            className="ml-1 shrink-0"
                            style={{ color: 'var(--text-muted)' }}
                        >
                            <X className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                    </div>
                ) : null}
            </div>
        </Field>
    );
}
