import { ImagePlus, X } from 'lucide-react';
import { useState } from 'react';
import Button from '@/components/shared/Button';
import FormField from '@/components/shared/FormField';
import useTranslation from '@/hooks/useTranslation';
import AssetImage from '../../runtime/assets/AssetImage';
import { isAssetRef } from '../../runtime/assets/assetUrl';
import { INPUT_CLS } from '../panels/kit';
import AssetPicker, { type AssetKind } from './AssetPicker';

interface AssetRefFieldProps {
    label: string;
    /** An https URL, `asset:<id>`, or empty. */
    value: string | null | undefined;
    /** The trimmed value, or null for empty. */
    onChange: (value: string | null) => void;
    appId: string | null;
    definition: unknown;
    placeholder?: string;
    hint?: string;
    disabled?: boolean;
    kind?: AssetKind;
}

/**
 * A field that takes an https URL or an uploaded file of the app. The text box keeps the
 * URL route exactly as it was; "Choose a file" opens the app's uploaded files (upload,
 * pick, delete). An uploaded file shows as a preview with a remove button, not as its id.
 */
export default function AssetRefField({ label, value, onChange, appId, definition, placeholder, hint, disabled = false, kind = 'image' }: AssetRefFieldProps) {
    const { t } = useTranslation();
    const [picking, setPicking] = useState(false);
    const uploaded = isAssetRef(value);
    return (
        <FormField label={label} hint={hint}>
            <div className="flex flex-col gap-1.5">
                {uploaded ? (
                    <div className="flex items-center gap-2 rounded-md border border-[var(--border-default)] p-1.5" data-asset-ref={value}>
                        <span className="flex h-10 w-14 items-center justify-center overflow-hidden rounded bg-[var(--bg-tertiary)]">
                            <AssetImage value={value} appId={appId} alt="" className="max-h-10 max-w-full object-contain" />
                        </span>
                        <span className="flex-1 truncate text-xs text-[var(--text-secondary)]">{t('studio_apps_assets.uploaded_value', 'Uploaded file')}</span>
                        <Button size="sm" variant="ghost" icon={X} disabled={disabled} onClick={() => onChange(null)} aria-label={t('studio_apps_assets.clear', 'Remove')} />
                    </div>
                ) : (
                    <input
                        type="text"
                        className={INPUT_CLS}
                        value={value ?? ''}
                        onChange={(e) => onChange(e.target.value.trim() || null)}
                        placeholder={placeholder}
                        disabled={disabled}
                        spellCheck={false}
                        aria-label={label}
                    />
                )}
                <div>
                    <Button size="sm" variant="secondary" icon={ImagePlus} disabled={disabled || !appId} onClick={() => setPicking(true)}>
                        {t('studio_apps_assets.choose', 'Choose an uploaded file')}
                    </Button>
                </div>
            </div>
            {/* Mounted only while open: the list is read when someone asks for it. */}
            {picking ? (
                <AssetPicker
                    open
                    onClose={() => setPicking(false)}
                    appId={appId}
                    definition={definition}
                    kind={kind}
                    onPick={(ref) => { onChange(ref); setPicking(false); }}
                />
            ) : null}
        </FormField>
    );
}
