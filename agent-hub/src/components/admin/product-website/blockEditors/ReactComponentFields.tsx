// The "Fields" card of the React component block: which props an editor can
// change, their label, type and (for a select) options. The values themselves
// are edited in the "Props" card (ReactComponentProps.tsx).
import { useTranslation } from '@/hooks/useTranslation';
import { FieldRow, RepeatableList, TextField, inputCls } from '../fields';
import { FieldSelect } from '../primitives';
import {
    FIELD_TYPE_LIST, fieldNameProblem, nextFieldName, parseOptions, propsForFields, updateField,
    type ReactField,
} from './reactComponentModel';

type T = (key: string, english: string, vars?: Record<string, unknown>) => string;

export type FieldsChange = {
    fields: ReactField[];
    props: Record<string, unknown>;
};

interface ReactComponentFieldsProps {
    fields: ReactField[];
    props: Record<string, unknown>;
    onChange: (next: FieldsChange) => void;
}

function typeOptions(t: T) {
    const labels: Record<string, string> = {
        text: t('cms_site.blocks.react_component.type_text', 'Text'),
        textarea: t('cms_site.blocks.react_component.type_textarea', 'Long text'),
        number: t('cms_site.blocks.react_component.type_number', 'Number'),
        boolean: t('cms_site.blocks.react_component.type_boolean', 'On / off'),
        color: t('cms_site.blocks.react_component.type_color', 'Colour'),
        image: t('cms_site.blocks.react_component.type_image', 'Image'),
        link: t('cms_site.blocks.react_component.type_link', 'Link'),
        select: t('cms_site.blocks.react_component.type_select', 'Choice'),
    };
    return FIELD_TYPE_LIST.map((value) => ({ value, label: labels[value] || value }));
}

function nameHint(problem: string, t: T): string {
    if (problem === 'invalid') return t('cms_site.blocks.react_component.name_invalid', 'Use letters, digits, _ or $, not starting with a digit (at most 40).');
    if (problem === 'duplicate') return t('cms_site.blocks.react_component.name_duplicate', 'Another field already has this name.');
    return t('cms_site.blocks.react_component.name_hint', 'The name your code reads the value under, e.g. title.');
}

interface FieldRowEditorProps {
    field: ReactField;
    index: number;
    fields: ReactField[];
    onField: (index: number, next: ReactField) => void;
    t: T;
}

function FieldRowEditor({ field, index, fields, onField, t }: FieldRowEditorProps) {
    const problem = fieldNameProblem(field.name, index, fields);
    const patch = (p: Partial<ReactField>) => onField(index, { ...field, ...p });
    return (
        <>
            <FieldRow label={t('cms_site.blocks.react_component.field_name', 'Prop name')} hint={nameHint(problem, t)}>
                <input
                    className={inputCls + ' font-mono'}
                    value={field.name}
                    aria-invalid={problem ? true : undefined}
                    aria-label={t('cms_site.blocks.react_component.field_name', 'Prop name')}
                    onChange={(e) => patch({ name: e.target.value.trim() })}
                    spellCheck={false}
                />
            </FieldRow>
            <TextField
                label={t('cms_site.blocks.react_component.field_label', 'Label')}
                value={field.label || ''}
                onChange={(v) => patch({ label: v })}
            />
            <FieldSelect
                label={t('cms_site.blocks.react_component.field_type', 'Type')}
                value={field.type}
                options={typeOptions(t)}
                onChange={(v) => patch({ type: v })}
            />
            {field.type === 'select' ? (
                <TextField
                    label={t('cms_site.blocks.react_component.field_options', 'Options')}
                    hint={t('cms_site.blocks.react_component.field_options_hint', 'Separate the choices with commas.')}
                    value={(field.options || []).join(', ')}
                    onChange={(v) => patch({ options: parseOptions(v) })}
                />
            ) : null}
            <TextField
                label={t('cms_site.blocks.react_component.field_help', 'Help text')}
                value={field.help || ''}
                onChange={(v) => patch({ help: v })}
            />
        </>
    );
}

export function ReactComponentFields({ fields, props, onChange }: ReactComponentFieldsProps) {
    const { t } = useTranslation();
    const onField = (index: number, next: ReactField) => onChange(updateField(fields, props, index, next));
    const onList = (next: ReactField[]) => onChange({ fields: next, props: propsForFields(fields, next, props) });
    return (
        <RepeatableList<ReactField>
            items={fields}
            onChange={onList}
            collapsible
            itemLabel={(f) => f.label || f.name}
            addLabel={t('cms_site.blocks.react_component.add_field', 'Add field')}
            makeNew={() => ({ name: nextFieldName(fields), label: '', type: 'text' })}
            renderItem={(field, _update, index) => (
                <FieldRowEditor field={field} index={index} fields={fields} onField={onField} t={t} />
            )}
        />
    );
}
