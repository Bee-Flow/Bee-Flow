import { Trash2, Type, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Button from '@/components/shared/Button';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import Modal from '@/components/shared/Modal';
import Spinner from '@/components/shared/Spinner';
import useTranslation from '@/hooks/useTranslation';
import { RefusedError } from '@/api/mutate';
import { deleteStudioAsset, listStudioAssets, uploadStudioAsset, type StudioAsset } from '@/api/studioAssetsApi';
import AssetImage from '../../runtime/assets/AssetImage';
import { assetPathsIn } from './assetUsage';

export type AssetKind = 'image' | 'font';

interface AssetPickerProps {
    open: boolean;
    onClose: () => void;
    appId: string | null;
    /** The editor's copy, for "still used by" before a delete (it may hold unsaved changes). */
    definition: unknown;
    kind: AssetKind;
    onPick: (ref: string) => void;
}

const ACCEPT: Record<AssetKind, string> = {
    image: '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif',
    font: '.woff2,font/woff2',
};

type T = ReturnType<typeof useTranslation>['t'];

/** The reason a refused upload gets, in product words. */
function uploadErrorText(err: unknown, t: T, maxMb: number): string {
    const status = err instanceof RefusedError ? err.status : 0;
    if (status === 409) return t('studio_apps_assets.error_full', "This app's file storage is full. Delete a file you no longer use.");
    if (status === 413) return t('studio_apps_assets.error_size', 'The file is too large (at most {mb} MB).', { mb: maxMb });
    if (status === 415) return t('studio_apps_assets.error_type', 'Only PNG, JPEG, WebP and GIF images and WOFF2 fonts can be uploaded.');
    if (status === 422) return t('studio_apps_assets.error_scan', 'The file failed a malware scan and was refused.');
    return t('studio_apps_assets.error_generic', 'The upload failed ({status}).', { status: status || '?' });
}

/** The warning before a delete: where the draft (the editor's copy) and the published app still use it. */
function deleteText(asset: StudioAsset, definition: unknown, t: T): string {
    const draft = assetPathsIn(definition, asset.id);
    const published = asset.usedBy.published;
    if (!draft.length && !published.length) return t('studio_apps_assets.delete_unused', 'Nothing in this app uses it.');
    return t('studio_apps_assets.delete_used', 'Still used in {draft} place(s) of this draft and {published} of the published app ({paths}). Those images show an empty placeholder after deleting.', {
        draft: draft.length, published: published.length, paths: [...new Set([...draft, ...published])].slice(0, 3).join(', '),
    });
}

function isFont(asset: StudioAsset): boolean {
    return asset.mime.startsWith('font/');
}

function AssetTile({ asset, appId, usedCount, onUse, onDelete }: { asset: StudioAsset; appId: string; usedCount: number; onUse: () => void; onDelete: () => void }) {
    const { t } = useTranslation();
    return (
        <li className="flex flex-col gap-1.5 rounded-md border border-[var(--border-default)] p-2" data-asset-id={asset.id}>
            <div className="flex h-20 items-center justify-center overflow-hidden rounded bg-[var(--bg-tertiary)] text-[var(--text-muted)]">
                {isFont(asset)
                    ? <Type className="h-6 w-6" aria-label={t('studio_apps_assets.font_label', 'Font')} />
                    : <AssetImage value={asset.ref} appId={appId} alt="" className="max-h-20 max-w-full object-contain" />}
            </div>
            <span className="text-[11px] text-[var(--text-secondary)]">
                {t('studio_apps_assets.size_kb', '{size} KB', { size: Math.max(1, Math.round(asset.size / 1024)) })}
                {' · '}
                {usedCount
                    ? t('studio_apps_assets.used_count', 'used in {count} place(s)', { count: usedCount })
                    : t('studio_apps_assets.unused', 'not used')}
            </span>
            <div className="flex gap-1">
                <Button size="sm" variant="secondary" onClick={onUse} className="flex-1">{t('studio_apps_assets.use', 'Use')}</Button>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={onDelete} aria-label={t('studio_apps_assets.delete', 'Delete')} />
            </div>
        </li>
    );
}

function UploadButton({ kind, pending, onFile }: { kind: AssetKind; pending: boolean; onFile: (file: File) => void }) {
    const { t } = useTranslation();
    const inputRef = useRef<HTMLInputElement>(null);
    return (
        <div>
            <Button size="sm" variant="secondary" icon={Upload} disabled={pending} onClick={() => inputRef.current?.click()}>
                {pending ? t('studio_apps_assets.uploading', 'Uploading…') : t('studio_apps_assets.upload', 'Upload a file')}
            </Button>
            <input
                ref={inputRef}
                type="file"
                accept={ACCEPT[kind]}
                className="hidden"
                aria-label={t('studio_apps_assets.upload', 'Upload a file')}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (file) onFile(file);
                }}
            />
        </div>
    );
}

/**
 * The uploaded files of the app: upload one, pick one (its `asset:<id>` goes to the field
 * that opened the picker), or delete one, with a warning when the draft or the published
 * app still uses it. Images and fonts are listed apart, by the field's kind.
 */
export default function AssetPicker({ open, onClose, appId, definition, kind, onPick }: AssetPickerProps) {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const [error, setError] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<StudioAsset | null>(null);
    const queryKey = ['studio-app-assets', appId];
    const list = useQuery({ queryKey, queryFn: () => listStudioAssets(appId as string), enabled: open && !!appId });
    const maxMb = Math.round((list.data?.limits.maxBytes ?? 5 * 1024 * 1024) / (1024 * 1024));
    const refresh = () => queryClient.invalidateQueries({ queryKey });
    const upload = useMutation({
        mutationFn: (file: File) => uploadStudioAsset(appId as string, file),
        onSuccess: (asset) => { setError(null); refresh(); onPick(asset.ref); },
        onError: (err) => setError(uploadErrorText(err, t, maxMb)),
    });
    const remove = useMutation({
        mutationFn: (asset: StudioAsset) => deleteStudioAsset(appId as string, asset.id),
        onSettled: () => { setConfirming(null); refresh(); },
    });

    const shown = (list.data?.assets || []).filter((a) => (kind === 'font') === isFont(a));
    const usedPaths = (asset: StudioAsset) => [...new Set([...assetPathsIn(definition, asset.id), ...asset.usedBy.published])];

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="lg"
            title={t('studio_apps_assets.picker_title', 'Uploaded files')}
            description={t('studio_apps_assets.picker_description', 'PNG, JPEG, WebP and GIF images and WOFF2 fonts of this app, up to {mb} MB each. No SVG.', { mb: maxMb })}
        >
            {!appId ? (
                <p className="text-sm text-[var(--text-secondary)]">{t('studio_apps_assets.no_app', 'Save the app first to upload files.')}</p>
            ) : (
                <div className="flex flex-col gap-3">
                    <UploadButton kind={kind} pending={upload.isPending} onFile={(file) => upload.mutate(file)} />
                    {error ? <p role="alert" className="text-xs text-[var(--error)]">{error}</p> : null}
                    {list.isLoading ? <Spinner size="sm" /> : null}
                    {list.isError ? <p role="alert" className="text-xs text-[var(--error)]">{t('studio_apps_assets.error_list', 'The uploaded files could not be loaded.')}</p> : null}
                    {list.isSuccess && !shown.length ? <p className="text-sm text-[var(--text-secondary)]">{t('studio_apps_assets.empty', 'No files uploaded yet.')}</p> : null}
                    {shown.length ? (
                        <ul className="grid grid-cols-3 gap-2">
                            {shown.map((asset) => (
                                <AssetTile
                                    key={asset.id}
                                    asset={asset}
                                    appId={appId}
                                    usedCount={usedPaths(asset).length}
                                    onUse={() => onPick(asset.ref)}
                                    onDelete={() => setConfirming(asset)}
                                />
                            ))}
                        </ul>
                    ) : null}
                </div>
            )}
            <ConfirmDialog
                open={!!confirming}
                title={t('studio_apps_assets.delete_title', 'Delete this file?')}
                description={confirming ? deleteText(confirming, definition, t) : undefined}
                confirmLabel={t('studio_apps_assets.delete', 'Delete')}
                destructive
                onConfirm={() => { if (confirming) remove.mutate(confirming); }}
                onCancel={() => setConfirming(null)}
            />
        </Modal>
    );
}
