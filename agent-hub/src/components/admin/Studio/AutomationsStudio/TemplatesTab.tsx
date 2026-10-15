import React from 'react';
import TemplateGallery from './TemplateGallery';
import type { TemplateGalleryProps } from './TemplateGallery';

interface TemplatesTabProps {
    onPickTemplate?: TemplateGalleryProps['onPick'];
}

export default function TemplatesTab({ onPickTemplate }: TemplatesTabProps) {
    if (!onPickTemplate) return null;
    return <TemplateGallery onPick={onPickTemplate} />;
}
