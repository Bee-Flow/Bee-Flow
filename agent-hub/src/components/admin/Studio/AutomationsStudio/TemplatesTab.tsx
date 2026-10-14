import React from 'react';
import TemplateGallery from './TemplateGallery';

export default function TemplatesTab({ onPickTemplate }: { onPickTemplate?: React.ComponentProps<typeof TemplateGallery>['onPick'] }) {
    if (!onPickTemplate) return null;
    return <TemplateGallery onPick={onPickTemplate} />;
}
