import React from 'react';
import useTranslation from '../../../../../../hooks/useTranslation';
import Toggle from '../../../../../shared/Toggle';
import { registerInspector } from '../registry';
import { TextAreaField , usePatch } from './kit';
import type { PanelProps } from '../appDefinition';

interface TextProps {
    text?: string;
    muted?: boolean;
}

function TextInspector({ node, definition, onCommit, disabled = false }: PanelProps<TextProps>) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextAreaField
                label={t('studio_apps_panels.common.text', 'Text')}
                value={props.text}
                onChange={(v) => patch({ text: v })}
                rows={4}
                hint={t('studio_apps_panels.text.hint', 'Supports **bold**, *italic* and [links](https://…).')}
                disabled={disabled}
            />
            <Toggle
                label={t('studio_apps_panels.text.muted', 'Muted')}
                description={t('studio_apps_panels.text.muted_desc', 'Render in the secondary text color.')}
                checked={!!props.muted}
                onChange={(v) => patch({ muted: v })}
                disabled={disabled}
                size="sm"
            />
        </div>
    );
}

registerInspector('text', TextInspector);
