import { useEffect, useState } from 'react';
import { FieldRow, inputClass } from './basicFields';
import { AssetPickerDialog } from './jsDeps';
import { useTranslation } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { uploadCmsFile } from '../cmsUpload';

/**
 * Resolve a stored image value to a displayable URL: full http(s) URLs and
 * absolute paths pass through, bare CMS asset keys ("cms/…") map to the
 * asset route. Mirror of the renderer-side resolveAssetUrl in
 * marketing/ProductWebsite.jsx — kept separate so the admin bundle doesn't
 * import the marketing renderer.
 */
export function resolveCmsAssetUrl(urlOrKey: string | null | undefined): string {
    if (!urlOrKey) return '';
    if (urlOrKey.startsWith('http://') || urlOrKey.startsWith('https://') || urlOrKey.startsWith('/')) return urlOrKey;
    if (urlOrKey.startsWith('cms/')) {
        return `/api/cms/asset/${urlOrKey.split('/').map(encodeURIComponent).join('/')}`;
    }
    return urlOrKey;
}

// Probes the asset-library route once per session and caches the verdict
// module-side, so N image fields on one page don't each fire a request.
// `false` (route missing, storage in local-fs mode, or not an admin) hides
// every Browse button — the picker is pure convenience over upload/paste.
let assetLibraryProbe: { settled: boolean; value: boolean; promise?: Promise<boolean> } | null = null;
function useAssetLibraryAvailable(enabled: boolean): boolean {
    const [available, setAvailable] = useState(
        () => (assetLibraryProbe?.settled ? assetLibraryProbe.value : false));
    useEffect(() => {
        if (!enabled) return undefined;
        if (!assetLibraryProbe) {
            const probe: { settled: boolean; value: boolean; promise?: Promise<boolean> } = { settled: false, value: false };
            assetLibraryProbe = probe;
            probe.promise = authFetch(`${API_BASE}/api/cms/admin/assets`)
                .then((r: Response) => (r.ok ? r.json() : null))
                .then((data: { unavailable?: boolean } | null) => !!(data && data.unavailable !== true))
                .catch(() => false)
                .then((v: boolean) => {
                    probe.settled = true;
                    probe.value = v;
                    return v;
                });
        }
        let cancelled = false;
        Promise.resolve(assetLibraryProbe.promise).then(v => {
            if (!cancelled) setAvailable(!!v);
        });
        return () => { cancelled = true; };
    }, [enabled]);
    return enabled && available;
}

type PreviewKind = 'image' | 'video' | 'clip' | 'captions';

interface ImageFieldProps {
    value: string | null | undefined;
    onChange: (url: string) => void;
    label?: string;
    /** Drives the file input's accept attribute (e.g. `video/mp4,video/webm` for a silent video). */
    accept?: string;
    /** Thumbnail: an <img>, or an inline <video> for video/clip. */
    previewKind?: PreviewKind;
    /** Upload button text, so the user knows what kind of file is expected. */
    uploadLabel?: string;
    placeholder?: string;
    /** Offer the media-library "Browse" entry point (hidden anyway when unavailable). */
    allowBrowse?: boolean;
    /** 'upload-clip' sends to the 500 MB clip endpoint with progress; 'upload' is the 25 MB image/loop one. */
    uploadPath?: 'upload' | 'upload-clip';
    /** Which kind the media library lists; defaults from previewKind. */
    libraryKind?: 'image' | 'video' | 'captions';
}

/** Upload one file (clip uploads report progress); resolves to the stored URL. */
async function uploadAsset(file: File, uploadPath: string, onProgress: (pct: number | null) => void, failedText: (status: number) => string): Promise<string> {
    if (uploadPath === 'upload-clip') {
        const result = await uploadCmsFile(file, { path: 'upload-clip', onProgress });
        return result.url;
    }
    const fd = new FormData();
    fd.append('file', file);
    const res = await authFetch(`${API_BASE}/api/cms/admin/upload`, {
        method: 'POST',
        body: fd,
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || failedText(res.status));
    }
    const data = await res.json();
    return data.url;
}

function AssetThumb({ value, previewKind }: { value: string; previewKind: PreviewKind }) {
    if (previewKind === 'captions') return <span aria-hidden="true">{'CC'}</span>;
    // A still frame only: preload=metadata keeps a 100 MB clip from downloading into a thumbnail.
    if (previewKind === 'clip') return <video src={resolveCmsAssetUrl(value)} muted preload="metadata" playsInline className="w-full h-full object-contain" />;
    if (previewKind === 'video') return <video src={resolveCmsAssetUrl(value)} muted autoPlay loop playsInline className="w-full h-full object-contain" />;
    return <img src={resolveCmsAssetUrl(value)} alt="" className="w-full h-full object-contain" />;
}

export function ImageField({
    value,
    onChange,
    label,
    accept = 'image/*',
    previewKind = 'image',
    uploadLabel,
    placeholder,
    allowBrowse = true,
    uploadPath = 'upload',
    libraryKind,
}: ImageFieldProps) {
    const { t } = useTranslation();
    const [uploading, setUploading] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [browsing, setBrowsing] = useState(false);
    const libraryAvailable = useAssetLibraryAvailable(allowBrowse);

    const handleFile = async (file: File | undefined) => {
        if (!file) return;
        setUploading(true);
        setError(null);
        setProgress(null);
        try {
            onChange(await uploadAsset(file, uploadPath, setProgress, (status) => t('cms_site.site.fields.upload_failed', 'Upload failed ({status})', { status })));
        } catch (err) {
            setError((err as Error).message);
        } finally {
            setUploading(false);
            setProgress(null);
        }
    };

    const previewIsVideo = previewKind === 'video' || previewKind === 'clip';
    const pickerKind = libraryKind || (previewIsVideo ? 'video' : (previewKind === 'captions' ? 'captions' : 'image'));
    const uploadText = uploading
        ? (progress === null ? t('cms_site.site.fields.uploading', 'Uploading…') : t('cms_site.site.fields.uploading_pct', 'Uploading… {pct}%', { pct: progress }))
        : (uploadLabel || t('cms_site.site.fields.upload_image', 'Upload image'));
    return (
        <FieldRow label={label}>
            <div className="flex items-start gap-3">
                <div className="w-16 h-16 rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-default)] overflow-hidden flex items-center justify-center text-xs text-[var(--text-muted)]">
                    {value ? <AssetThumb value={value} previewKind={previewKind} /> : '—'}
                </div>
                <div className="flex-1 flex flex-col gap-2">
                    <input
                        type="text"
                        className={inputClass}
                        value={value || ''}
                        onChange={(e) => onChange(e.target.value)}
                        placeholder={placeholder || t('cms_site.site.fields.image_placeholder', 'https://… or /api/cms/asset/cms/…')}
                    />
                    <div className="flex items-center gap-2">
                        <label className="px-3 py-1.5 text-xs rounded-md cursor-pointer bg-[var(--bg-tertiary)] border border-[var(--border-default)] hover:border-[var(--accent-primary)] transition-colors">
                            {uploadText}
                            <input
                                type="file"
                                accept={accept}
                                className="hidden"
                                disabled={uploading}
                                onChange={(e) => handleFile(e.target.files?.[0])}
                            />
                        </label>
                        {libraryAvailable ? (
                            <button
                                type="button"
                                onClick={() => setBrowsing(true)}
                                className="px-3 py-1.5 text-xs rounded-md bg-[var(--bg-tertiary)] border border-[var(--border-default)] hover:border-[var(--accent-primary)] transition-colors text-[var(--text-secondary)]"
                            >
                                {t('cms_site.site.fields.browse', 'Browse…')}
                            </button>
                        ) : null}
                        {value ? (
                            <button
                                type="button"
                                onClick={() => onChange('')}
                                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                            >
                                {t('cms_site.site.fields.remove', 'Remove')}
                            </button>
                        ) : null}
                    </div>
                    {uploading && progress !== null ? (
                        <progress
                            className="w-full h-1.5"
                            value={progress}
                            max={100}
                            aria-label={t('cms_site.site.fields.upload_progress', 'Upload progress {pct}%', { pct: progress })}
                        />
                    ) : null}
                    {error ? <span className="text-xs text-red-400" role="alert">{error}</span> : null}
                </div>
            </div>
            {browsing ? (
                <AssetPickerDialog
                    accept={pickerKind}
                    onPick={onChange}
                    onClose={() => setBrowsing(false)}
                />
            ) : null}
        </FieldRow>
    );
}
