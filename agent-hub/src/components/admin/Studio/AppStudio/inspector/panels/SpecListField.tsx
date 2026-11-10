import BindingField from './BindingField';
import { IconField } from './kit';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { RepeatableList, inputCls } from '@/components/admin/product-website/fields';
import { actionOptions } from '../actionLabels';
import { humanize, itemTitle, newListItem, setItemKey } from './specProps';
import type { ListItem, PropSpec } from './specProps';
import type { BindingInput } from '../../runtime/resolveBinding.types';
import type { AppDefinition, AppNode } from '../appDefinition';

/**
 * The list editor of the generic inspector, driven by a list prop's
 * `itemShape`. Every key of an item gets its own control, the same mapping the
 * top-level props use: a binding gets the real BindingField, an icon the icon
 * picker, a nested list (a column's value→tone map) another list editor, and a
 * key that names an action a picker over the app's actions. Clearing a key
 * removes it from the item (see specProps.setItemKey).
 */

/** What every item control needs besides its own value. */
interface ItemContext {
    definition?: AppDefinition | null;
    node?: AppNode | null;
}

interface ItemFieldProps extends ItemContext {
    itemKey: string;
    fs: PropSpec;
    value: unknown;
    onChange: (value: unknown) => void;
}

/** An item key that holds the id of one of the app's actions. */
function isActionKey(key: string) {
    return key === 'actionId' || key.endsWith('ActionId');
}

function EnumItem({ itemKey, fs, value, onChange }: ItemFieldProps) {
    const { t } = useTranslation();
    const values = fs.values || [];
    const offerDefault = !fs.required && !values.includes(null);
    return (
        <select
            className={inputCls}
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
            aria-label={humanize(itemKey)}
        >
            {offerDefault ? (
                <option value="">
                    {fs.default == null
                        ? t('studio_apps_more_options.item_default', '(default)')
                        : t('studio_apps_more_options.item_default_named', '(default: {value})', { value: String(fs.default) })}
                </option>
            ) : null}
            {values.map((v) => (
                <option key={String(v)} value={v == null ? '' : String(v)}>{v === null ? t('studio_apps_more_options.item_default', '(default)') : String(v)}</option>
            ))}
        </select>
    );
}

function NumberItem({ itemKey, fs, value, onChange }: ItemFieldProps) {
    return (
        <input
            type="number"
            className={inputCls}
            value={value == null ? '' : String(value)}
            min={fs.min}
            max={fs.max}
            step={fs.type === 'int' ? 1 : 'any'}
            onChange={(e) => {
                const n = Number(e.target.value);
                if (e.target.value === '' || !Number.isFinite(n)) { onChange(null); return; }
                onChange(fs.type === 'int' ? Math.round(n) : n);
            }}
            aria-label={humanize(itemKey)}
        />
    );
}

function ActionItem({ itemKey, value, onChange, definition }: ItemFieldProps) {
    const { t } = useTranslation();
    const actions = actionOptions(definition);
    const current = typeof value === 'string' ? value : '';
    const known = !current || actions.some((a) => a.id === current);
    return (
        <select className={inputCls} value={current} onChange={(e) => onChange(e.target.value || null)} aria-label={humanize(itemKey)}>
            <option value="">{t('studio_apps_more_options.no_action', 'No action')}</option>
            {actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            {known ? null : <option value={current}>{current}</option>}
        </select>
    );
}

function TextItem({ itemKey, value, onChange }: ItemFieldProps) {
    return (
        <input
            type="text"
            className={inputCls}
            value={value == null ? '' : String(value)}
            onChange={(e) => onChange(e.target.value)}
            placeholder={humanize(itemKey)}
            spellCheck={false}
            aria-label={humanize(itemKey)}
        />
    );
}

function BooleanItem({ itemKey, fs, value, onChange }: ItemFieldProps) {
    const checked = value === undefined || value === null ? fs.default === true : !!value;
    return (
        <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
            <input
                type="checkbox"
                checked={checked}
                onChange={(e) => onChange(e.target.checked)}
                className="accent-[var(--accent-primary)]"
            />
            {humanize(itemKey)}
        </label>
    );
}

/** The control for one key of one item, without its label. */
function ItemControl(props: ItemFieldProps) {
    const { itemKey, fs, value, onChange, definition, node } = props;
    switch (fs.type) {
        case 'enum': return <EnumItem {...props} />;
        case 'int':
        case 'number': return <NumberItem {...props} />;
        case 'icon':
            return <IconField label={null} hint={null} value={typeof value === 'string' ? value : null} onChange={onChange} />;
        case 'binding':
            if (!definition) return <TextItem {...props} />;
            return <BindingField label={null} value={value as BindingInput} onChange={onChange} definition={definition} node={node} />;
        case 'list':
            return (
                <SpecListField
                    label={humanize(itemKey)}
                    itemShape={fs.itemShape}
                    maxItems={fs.maxItems}
                    items={Array.isArray(value) ? value as ListItem[] : undefined}
                    onChange={onChange}
                    definition={definition}
                    node={node}
                />
            );
        default:
            return isActionKey(itemKey) && definition ? <ActionItem {...props} /> : <TextItem {...props} />;
    }
}

/** One key of one item: a labelled control (a checkbox and a nested list carry their own label). */
export function ItemField(props: ItemFieldProps) {
    const { fs, itemKey } = props;
    if (fs.type === 'boolean') return <BooleanItem {...props} />;
    if (fs.type === 'list') return <ItemControl {...props} />;
    return (
        <FormField label={<span className="text-xs text-[var(--text-secondary)]">{humanize(itemKey)}</span>}>
            <ItemControl {...props} />
        </FormField>
    );
}

/** The keys of an item, each with its own control, writing through setItemKey. */
function ItemFields({ item, shape, keys, update, definition, node }: ItemContext & {
    item: ListItem;
    shape: Record<string, PropSpec>;
    keys: string[];
    update: (next: ListItem) => void;
}) {
    return (
        <div className="flex flex-col gap-2">
            {keys.map((k) => (
                <ItemField
                    key={k}
                    itemKey={k}
                    fs={shape[k]}
                    value={item?.[k]}
                    onChange={(v) => update(setItemKey(item, k, shape[k], v))}
                    definition={definition}
                    node={node}
                />
            ))}
        </div>
    );
}

interface SpecListFieldProps extends ItemContext {
    label: string;
    itemShape: Record<string, PropSpec> | null | undefined;
    items: ListItem[] | undefined;
    onChange: (items: ListItem[]) => void;
    disabled?: boolean;
    maxItems?: number;
}

export function SpecListField({ label, itemShape, items, onChange, disabled = false, maxItems, definition = null, node = null }: SpecListFieldProps) {
    const { t } = useTranslation();
    const shape = itemShape || {};
    const keys = Object.keys(shape);
    return (
        <fieldset disabled={disabled} className="min-w-0">
            <RepeatableList
                label={label}
                items={Array.isArray(items) ? items : []}
                onChange={onChange}
                makeNew={() => newListItem(itemShape)}
                addLabel={t('studio_apps_panels.spec.add_item', 'Add {item}', { item: label.toLowerCase().replace(/s$/, '') })}
                collapsible
                maxItems={maxItems}
                itemLabel={(item: ListItem) => itemTitle(item, itemShape)}
                renderItem={(item: ListItem, update: (next: ListItem) => void) => (
                    <ItemFields item={item} shape={shape} keys={keys} update={update} definition={definition} node={node} />
                )}
            />
        </fieldset>
    );
}
