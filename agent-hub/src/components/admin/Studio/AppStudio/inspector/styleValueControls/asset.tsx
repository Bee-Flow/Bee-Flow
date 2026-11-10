import { ImagePlus, X } from 'lucide-react';
import { useState } from 'react';
import Button from '@/components/shared/Button';
import FormField from '@/components/shared/FormField';
import useTranslation from '@/hooks/useTranslation';
import AssetImage from '../../runtime/assets/AssetImage';
import { isAssetRef } from '../../runtime/assets/assetUrl';
import AssetPicker from '../assets/AssetPicker';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import { knobLabel } from '../styleKnobMeta';
import type { StyleValueControlProps } from '../styleValueControls';

/**
 * The control of a style knob of value type "asset" (a picture behind a component). Only a
 * file uploaded to the app is accepted, because that is all the knob keeps: the preview and
 * a remove button when one is set, otherwise "Choose an uploaded file" (upload, pick, delete).
 */
export default function AssetKnobControl({ knob, value, onChange, definition, disabled }: StyleValueControlProps) {
    const { t } = useTranslation();
    const appId = useEditorChrome()?.appId ?? null;
    const [picking, setPicking] = useState(false);
    const label = knobLabel(knob, t);
    return (
        <FormField label={label}>
            {isAssetRef(value) ? (
                <div className="flex items-center gap-2 rounded-md border border-[var(--border-default)] p-1.5" data-asset-ref={value}>
                    <span className="flex h-10 w-14 items-center justify-center overflow-hidden rounded bg-[var(--bg-tertiary)]">
                        <AssetImage value={value} appId={appId} alt="" className="max-h-10 max-w-full object-contain" />
                    </span>
                    <span className="flex-1 truncate text-xs text-[var(--text-secondary)]">{t('studio_apps_assets.uploaded_value', 'Uploaded file')}</span>
                    <Button size="sm" variant="ghost" icon={X} disabled={disabled} onClick={() => onChange(null)} aria-label={t('studio_apps_assets.clear', 'Remove')} />
                </div>
            ) : (
                <div>
                    <Button size="sm" variant="secondary" icon={ImagePlus} disabled={disabled || !appId} onClick={() => setPicking(true)}>
                        {t('studio_apps_assets.choose', 'Choose an uploaded file')}
                    </Button>
                </div>
            )}
            {picking ? (
                <AssetPicker
                    open
                    onClose={() => setPicking(false)}
                    appId={appId}
                    definition={definition}
                    kind="image"
                    onPick={(ref) => { onChange(ref); setPicking(false); }}
                />
            ) : null}
        </FormField>
    );
}
