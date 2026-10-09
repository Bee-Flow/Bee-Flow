import React from 'react';
import { TextField, usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import { registerInspector } from '../registry';
import Toggle from '../../../../../shared/Toggle';

/**
 * Content panel for input_person. Props mirror componentSpecs.js (authoritative).
 *
 * There is no source to choose: the list is always the organisation's own
 * members, answered by the platform. What the author picks is what the field
 * is called and whether "Me" is offered — so the panel is short on purpose.
 *
 * The note about the directory switch is here rather than buried in docs
 * because an app that has not opted in renders a picker that loads nothing, and
 * "the dropdown is empty" is a much worse thing to debug than "you have not
 * turned this on yet".
 */
export default function InputPersonInspector({ node, definition, onCommit, disabled = false }) {
    const props = node.props || {};
    const { t } = useTranslation();
    const patch = usePatch(node, definition, onCommit);

    return (
        <div className="flex flex-col gap-4">
            <TextField
                label={t('studio_apps_panels.common.field_name', 'Field name')}
                value={props.name}
                onChange={(v) => patch({ name: v })}
                hint={t('studio_apps_panels.input_person.field_name_hint', 'Submits the user id. Also publishes {name}_label with the display name — write both, so the row can show who it belongs to.', { name: props.name || 'person' })}
                disabled={disabled}
            />
            <TextField label={t('studio_apps_panels.common.label', 'Label')} value={props.label} onChange={(v) => patch({ label: v })} disabled={disabled} />
            <Toggle
                label={t('studio_apps_panels.input_person.offer_me', 'Offer “Me”')}
                checked={props.allowMe !== false}
                onChange={(v) => patch({ allowMe: v })}
                disabled={disabled}
                size="sm"
            />
            <Toggle
                label={t('studio_apps_panels.input_person.multiple', 'Allow several people')}
                checked={!!props.multiple}
                onChange={(v) => patch({ multiple: v })}
                disabled={disabled}
                size="sm"
            />
            <Toggle
                label={t('studio_apps_panels.common.required', 'Required')}
                checked={!!props.required}
                onChange={(v) => patch({ required: v })}
                disabled={disabled}
                size="sm"
            />
            <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('studio_apps_panels.input_person.directory_note', 'The list is your organisation’s members. It stays empty until this app is allowed to read the directory — turn that on in the app’s Data settings.')}
            </p>
        </div>
    );
}

registerInspector('input_person', InputPersonInspector);
