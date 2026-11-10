import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import { registerInspector } from '../registry';
import type { PanelProps } from '../appDefinition';
import { TextField , usePatch } from './kit';
import BindingField from './BindingField';
import AssetRefField from '../assets/AssetRefField';
import { useEditorChrome } from '../../editor/EditorChromeContext';
import type { BindingInput } from '../../runtime/resolveBinding.types';

interface ImageInspectorProps {
    src?: string | null;
    alt?: string | null;
    fit?: string;
    srcFrom?: BindingInput;
}

/** An unbound binding is no binding: it is stored as absent, so the app keeps its schema version. */
function boundOrNull(v: unknown): unknown {
    if (!v || typeof v !== 'object') return null;
    const b = v as { kind?: unknown; value?: unknown };
    return b.kind === 'static' && (b.value === null || b.value === undefined || b.value === '') ? null : v;
}

function ImageInspector({ node, definition, onCommit, disabled = false }: PanelProps<ImageInspectorProps>) {
    const props = node.props || {};
    const { t } = useTranslation();
    const appId = useEditorChrome()?.appId ?? null;
    const FITS = [
        { value: 'cover', label: t('studio_apps_panels.image.fit_cover', 'Cover') },
        { value: 'contain', label: t('studio_apps_panels.image.fit_contain', 'Contain') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <AssetRefField
                label={t('studio_apps_panels.image.url', 'Image URL')}
                value={props.src}
                onChange={(v) => patch({ src: v })}
                appId={appId}
                definition={definition}
                placeholder={t('studio_apps_panels.image.url_placeholder', 'https://…')}
                hint={t('studio_apps_assets.image_hint', 'An https URL, or a file uploaded to this app. Broken sources show a neutral placeholder.')}
                disabled={disabled}
            />
            <BindingField
                label={t('studio_apps_assets.image_from', 'Image from data')}
                value={props.srcFrom}
                onChange={(v) => patch({ srcFrom: boundOrNull(v) })}
                definition={definition}
                node={node}
                componentType="image"
                singleValue
                hint={t('studio_apps_assets.image_from_hint', 'A field or variable holding an https URL or an uploaded file wins over the image above.')}
                disabled={disabled}
            />
            <TextField
                label={t('studio_apps_panels.image.alt', 'Alt text')}
                value={props.alt}
                onChange={(v) => patch({ alt: v })}
                hint={t('studio_apps_panels.image.alt_hint', 'Describes the image for screen readers.')}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_panels.image.fit', 'Fit')}>
                <SegmentedControl
                    value={props.fit ?? 'cover'}
                    onChange={(v) => patch({ fit: v })}
                    options={FITS}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_panels.image.fit_aria', 'Image fit')}
                />
            </FormField>
        </div>
    );
}

registerInspector('image', ImageInspector);
