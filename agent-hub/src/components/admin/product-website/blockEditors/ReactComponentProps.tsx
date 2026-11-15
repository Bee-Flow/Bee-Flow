// The "Props" card of the React component block: one input per declared
// field, with the field kit every other block editor uses. A change reaches the
// live preview as a `bf-react-props` message, so the component keeps its state.
import { useTranslation } from '@/hooks/useTranslation';
import { FieldRow, ImageField, LinkField, TextArea, TextField, Toggle, inputCls } from '../fields';
import type { CmsLink, CmsPageOption } from '../fields';
import { ColorRow, FieldSelect } from '../primitives';
import type { ReactField } from './reactComponentModel';

interface ReactComponentPropsProps {
    fields: ReactField[];
    props: Record<string, unknown>;
    pages: CmsPageOption[];
    onChange: (props: Record<string, unknown>) => void;
}

interface PropInputProps {
    field: ReactField;
    value: unknown;
    pages: CmsPageOption[];
    onValue: (value: unknown) => void;
}

const asText = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));

function NumberInput({ field, value, onValue }: PropInputProps) {
    const label = field.label || field.name;
    return (
        <FieldRow label={label} hint={field.help}>
            <input
                type="number"
                className={inputCls}
                aria-label={label}
                value={Number.isFinite(Number(value)) && value !== '' ? Number(value) : ''}
                onChange={(e) => onValue(e.target.value === '' ? 0 : Number(e.target.value))}
            />
        </FieldRow>
    );
}

function PropInput(p: PropInputProps) {
    const { field, value, pages, onValue } = p;
    const label = field.label || field.name;
    switch (field.type) {
        case 'textarea':
            return <TextArea label={label} hint={field.help} value={asText(value)} onChange={onValue} rows={4} />;
        case 'number':
            return <NumberInput {...p} />;
        case 'boolean':
            return <Toggle label={label} value={value === true} onChange={onValue} />;
        case 'color':
            return <ColorRow label={label} hint={field.help} value={asText(value)} onChange={onValue} />;
        case 'image':
            return <ImageField label={label} value={asText(value)} onChange={onValue} />;
        case 'link':
            return <LinkField label={label} hint={field.help} value={value && typeof value === 'object' ? value as CmsLink : null} pages={pages} onChange={onValue} />;
        case 'select':
            return (
                <FieldSelect
                    label={label}
                    hint={field.help}
                    value={asText(value)}
                    options={(field.options || []).map((o) => ({ value: o, label: o }))}
                    onChange={onValue}
                />
            );
        default:
            return <TextField label={label} hint={field.help} value={asText(value)} onChange={onValue} />;
    }
}

export function ReactComponentProps({ fields, props, pages, onChange }: ReactComponentPropsProps) {
    const { t } = useTranslation();
    if (!fields.length) {
        return (
            <p className="text-xs text-[var(--text-muted)]">
                {t('cms_site.blocks.react_component.no_fields', 'No fields yet. Add one under Fields to edit a prop here without touching the code.')}
            </p>
        );
    }
    return (
        <>
            {fields.map((field, i) => (
                <PropInput
                    key={`${i}:${field.name}`}
                    field={field}
                    value={props[field.name]}
                    pages={pages}
                    onValue={(v) => onChange({ ...props, [field.name]: v })}
                />
            ))}
        </>
    );
}
