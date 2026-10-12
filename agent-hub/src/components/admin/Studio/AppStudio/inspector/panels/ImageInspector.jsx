import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import SegmentedControl from '../../../../../shared/SegmentedControl';
import { registerInspector } from '../registry';
import { TextField , usePatch } from './kit';

export default function ImageInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const FITS = [
        { value: 'cover', label: t('studio_apps_panels.image.fit_cover', 'Cover') },
        { value: 'contain', label: t('studio_apps_panels.image.fit_contain', 'Contain') },
    ];
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label={t('studio_apps_panels.image.url', 'Image URL')}
                value={props.src}
                onChange={(v) => patch({ src: v.trim() || null })}
                placeholder={t('studio_apps_panels.image.url_placeholder', 'https://…')}
                hint={t('studio_apps_panels.image.url_hint', 'Must be an https URL. Broken sources show a neutral placeholder.')}
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
