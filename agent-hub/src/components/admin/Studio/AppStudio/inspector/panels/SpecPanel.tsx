import { useQuery } from '@tanstack/react-query';
import React from 'react';
import { BindingField } from './bindingFieldTyped';
import ExpressionInput from '../logic/ExpressionInput';
import type { ComponentType } from 'react';
import { TextField, TextAreaField, NumberField, IconField, usePatch } from './kit';
import useTranslation from '../../../../../../hooks/useTranslation';
import FormField from '../../../../../shared/FormField';
import Toggle from '../../../../../shared/Toggle';
import { RepeatableList, inputCls } from '../../../../product-website/fields';
import { getComponentEntry } from '../../runtime/componentRegistry';
import { studioAppsApi } from '../../studioAppsApi';
import type { AppDefinition, AppNode } from '../appDefinition';
import type { PanelProps, PanelPatch } from '../inspectorTypes';

/**
 * SpecPanel — the GENERIC inspector Content panel, rendered from the server
 * catalog's prop specs (GET /api/studio-apps/catalog — componentSpecs.js
 * verbatim). Any component type without a bespoke panel falls back to this
 * (see registry.getInspectorForType), so a new catalog type gets a working
 * inspector for free instead of a silent editing gap.
 *
 * Prop-type → control mapping:
 *   string/url    → text field          markdown → textarea
 *   number/int    → number field        boolean  → toggle
 *   enum          → select              icon     → icon field
 *   binding       → BindingField        formula  → ExpressionInput
 *   list          → RepeatableList over itemShape (string/enum/int/boolean
 *                   item fields; nested lists are left to bespoke panels)
 *   stringList    → comma-separated text field
 *
 * The catalog is fetched once and cached for the session (react-query,
 * staleTime Infinity). If it is unavailable (offline draft), a minimal spec
 * is inferred from the registry's defaultProps so basic editing still works.
 */

/** One prop's spec, as componentSpecs.js declares it. */
export interface PropSpec {
    type: string;
    default?: unknown;
    values?: unknown[];
    min?: number;
    max?: number;
    itemShape?: PropSpecs | null;
}

/** A component's prop specs, by prop name. */
export type PropSpecs = Record<string, PropSpec>;

/** One row of a list-of-objects prop. */
type ListItem = Record<string, ItemValue>;

/** One item field's value (a nested list is never edited here). */
type ItemValue = string | number | boolean | null | undefined | unknown[];

interface StudioCatalog {
    components?: Record<string, { props?: PropSpecs }>;
    actions?: { stepSpecs?: unknown };
}

/** ExpressionInput is still JavaScript; its props are only inferred, so this states the contract the panel keeps. */
const ExpressionField = ExpressionInput as ComponentType<{
    value: string;
    onChange: (v: string) => void;
    definition: AppDefinition | null;
    node: AppNode | null;
    ariaLabel?: string | null;
    placeholder?: string;
    disabled?: boolean;
}>;

const CATALOG_QUERY_KEY = ['studio-apps', 'catalog'];

function useCatalog(): StudioCatalog | null {
    const { data } = useQuery({
        queryKey: CATALOG_QUERY_KEY,
        queryFn: () => studioAppsApi.getCatalog(),
        staleTime: Infinity,
        gcTime: Infinity,
        retry: 1,
    });
    return data || null;
}

/** Session-cached catalog components map ({ [type]: spec } or null). */
export function useCatalogComponents() {
    return useCatalog()?.components || null;
}

/**
 * The per-kind field tables for action steps (STEP_SPECS, verbatim).
 *
 * Read from the catalog rather than mirrored: eighteen kinds with their whole
 * field tables is far too much to keep in sync by hand, and the flow editor —
 * unlike a leaf field — only ever renders inside the editor shell, where the
 * query client already exists. Null while it loads.
 */
export function useCatalogStepSpecs() {
    return useCatalog()?.actions?.stepSpecs || null;
}

/** 'labelKey' / 'group_by' → 'Label key' / 'Group by'. */
function humanize(key: string): string {
    const words = String(key)
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Offline fallback: infer a minimal prop spec from registry defaultProps. */
export function inferSpecProps(defaultProps?: Record<string, unknown>): PropSpecs {
    const out: PropSpecs = {};
    for (const [key, v] of Object.entries(defaultProps || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && 'kind' in v) out[key] = { type: 'binding', default: v };
        else if (typeof v === 'boolean') out[key] = { type: 'boolean', default: v };
        else if (typeof v === 'number') out[key] = { type: 'number', default: v };
        else if (Array.isArray(v)) out[key] = { type: 'list', itemShape: null, default: [] };
        else out[key] = { type: 'string', default: v };
    }
    return out;
}

// ── list-of-objects editor (spec itemShape driven) ──────────────────────────

function newListItem(itemShape?: PropSpecs | null): ListItem {
    const item: ListItem = {};
    for (const [k, fs] of Object.entries(itemShape || {})) {
        if (fs.type === 'enum') item[k] = (fs.default ?? fs.values?.[0] ?? '') as ItemValue;
        else if (fs.type === 'boolean') item[k] = (fs.default ?? false) as ItemValue;
        else if (fs.type === 'int') item[k] = (fs.default ?? null) as ItemValue;
        else if (fs.type === 'list') item[k] = [];
        else item[k] = '';
    }
    return item;
}

function ItemField({ itemKey, fs, value, onChange }: {
    itemKey: string;
    fs: PropSpec;
    value: ItemValue;
    onChange: (v: ItemValue) => void;
}) {
    const { t } = useTranslation();
    if (fs.type === 'enum') {
        return (
            <select
                className={inputCls}
                value={(value ?? '') as string}
                onChange={(e) => onChange(e.target.value)}
                aria-label={humanize(itemKey)}
            >
                {(fs.values || []).map((v) => (
                    <option key={String(v)} value={(v ?? '') as string}>{v === null ? t('studio_apps_panels.spec.default_option', '(default)') : String(v)}</option>
                ))}
            </select>
        );
    }
    if (fs.type === 'boolean') {
        return (
            <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-secondary)]">
                <input
                    type="checkbox"
                    checked={!!value}
                    onChange={(e) => onChange(e.target.checked)}
                    className="accent-[var(--accent-primary)]"
                />
                {humanize(itemKey)}
            </label>
        );
    }
    if (fs.type === 'int') {
        return (
            <input
                type="number"
                className={inputCls}
                value={(value ?? '') as number | string}
                min={fs.min}
                max={fs.max}
                onChange={(e) => {
                    const n = Number(e.target.value);
                    onChange(e.target.value === '' || !Number.isFinite(n) ? null : Math.round(n));
                }}
                aria-label={humanize(itemKey)}
            />
        );
    }
    // string (nested lists are bespoke-panel territory — not rendered here)
    return (
        <input
            type="text"
            className={inputCls}
            value={(value ?? '') as string}
            onChange={(e) => onChange(e.target.value)}
            placeholder={humanize(itemKey)}
            spellCheck={false}
            aria-label={humanize(itemKey)}
        />
    );
}

export function SpecListField({ label, itemShape, items, onChange, disabled }: {
    label: string;
    itemShape?: PropSpecs | null;
    items: unknown;
    onChange: (items: ListItem[]) => void;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const shapeEntries = Object.entries(itemShape || {}).filter(([, fs]) => fs.type !== 'list');
    const labelKey = shapeEntries[0]?.[0];
    return (
        <fieldset disabled={disabled} className="min-w-0">
            <RepeatableList
                label={label}
                items={Array.isArray(items) ? items : []}
                onChange={onChange}
                makeNew={() => newListItem(itemShape)}
                addLabel={t('studio_apps_panels.spec.add_item', 'Add {item}', { item: label.toLowerCase().replace(/s$/, '') })}
                collapsible
                itemLabel={(item: ListItem) => (labelKey ? String(item?.[labelKey] ?? '') : '')}
                renderItem={(item: ListItem, update: (next: ListItem) => void) => (
                    <div className="flex flex-col gap-2">
                        {shapeEntries.map(([k, fs]) => (
                            <ItemField
                                key={k}
                                itemKey={k}
                                fs={fs}
                                value={item?.[k]}
                                onChange={(v) => update({ ...item, [k]: v })}
                            />
                        ))}
                    </div>
                )}
            />
        </fieldset>
    );
}

// ── one prop → one control ───────────────────────────────────────────────────

function SpecField({ propKey, fs, value, patch, definition, node, disabled }: {
    propKey: string;
    fs: PropSpec;
    value: unknown;
    patch: PanelPatch;
    definition: AppDefinition;
    node: AppNode;
    disabled?: boolean;
}) {
    const { t } = useTranslation();
    const label = humanize(propKey);
    const commit = (v: unknown) => patch({ [propKey]: v });

    switch (fs.type) {
        case 'binding':
            return (
                <BindingField
                    label={label}
                    value={value}
                    onChange={commit}
                    definition={definition}
                    disabled={disabled}
                />
            );
        case 'markdown':
            return <TextAreaField label={label} value={value as string} onChange={(v) => commit(v)} rows={5} disabled={disabled} />;
        case 'icon':
            return <IconField label={label} value={value as string} onChange={commit} disabled={disabled} />;
        case 'number':
        case 'int':
            return (
                <NumberField
                    label={label}
                    value={value as number | null}
                    step={fs.type === 'int' ? 1 : undefined}
                    onChange={(v) => {
                        if (v == null) { commit(null); return; }
                        let n = fs.type === 'int' ? Math.round(v) : v;
                        if (Number.isFinite(fs.min) && n < (fs.min as number)) n = fs.min as number;
                        if (Number.isFinite(fs.max) && n > (fs.max as number)) n = fs.max as number;
                        commit(n);
                    }}
                    hint={Number.isFinite(fs.min) && Number.isFinite(fs.max) ? `${fs.min}–${fs.max}` : undefined}
                    disabled={disabled}
                />
            );
        case 'boolean':
            return <Toggle label={label} checked={!!value} onChange={(v) => commit(v)} disabled={disabled} size="sm" />;
        case 'enum':
            return (
                <FormField label={label}>
                    <select
                        className={inputCls}
                        value={(value ?? '') as string}
                        onChange={(e) => commit(e.target.value === '' ? null : e.target.value)}
                        disabled={disabled}
                        aria-label={label}
                    >
                        {(fs.values || []).map((v) => (
                            <option key={String(v)} value={(v ?? '') as string}>{v === null ? t('studio_apps_panels.spec.default_option', '(default)') : String(v)}</option>
                        ))}
                    </select>
                </FormField>
            );
        case 'list': {
            if (!fs.itemShape) return null; // inferred fallback list — needs the real catalog
            return (
                <SpecListField
                    label={label}
                    itemShape={fs.itemShape}
                    items={value}
                    onChange={(items) => commit(items)}
                    disabled={disabled}
                />
            );
        }
        case 'stringList':
            return (
                <TextField
                    label={label}
                    value={Array.isArray(value) ? value.join(', ') : ((value ?? '') as string)}
                    onChange={(v) => commit(String(v).split(',').map((s) => s.trim()).filter(Boolean))}
                    hint={t('studio_apps_panels.spec.comma_separated', 'Comma-separated values')}
                    disabled={disabled}
                />
            );
        case 'formula':
            // Was a plain TextField: no picker, no parse check, no preview —
            // the author had to know both the syntax and the scope by heart.
            return (
                <FormField label={label} hint={t('studio_apps_panels.spec.formula_hint', 'Worked out on the page while it runs.')}>
                    <ExpressionField
                        value={(value || '') as string}
                        onChange={(v: string) => commit(v || null)}
                        definition={definition}
                        node={node}
                        ariaLabel={label}
                        placeholder={t('studio_apps_panels.spec.formula_placeholder', 'e.g. currentUser.name')}
                        disabled={disabled}
                    />
                </FormField>
            );
        case 'string':
        case 'url':
        default:
            return (
                <TextField
                    label={label}
                    value={value as string}
                    onChange={(v) => commit(v === '' && fs.default === null ? null : v)}
                    placeholder={fs.type === 'url' ? 'https://…' : (typeof fs.default === 'string' ? fs.default : undefined)}
                    disabled={disabled}
                />
            );
    }
}

export default function SpecPanel({ node, definition, onCommit, disabled = false }: PanelProps) {
    const props = (node.props || {}) as Record<string, unknown>;
    const patch = usePatch(node, definition, onCommit);
    const catalog = useCatalogComponents();

    const propSpecs = catalog?.[node.type as string]?.props
        || inferSpecProps(getComponentEntry(node.type as string)?.defaultProps);
    const entries = Object.entries(propSpecs || {});
    if (!entries.length) return null;

    return (
        <div className="flex flex-col gap-4" data-spec-panel={node.type}>
            {entries.map(([key, fs]) => (
                <SpecField
                    key={key}
                    propKey={key}
                    fs={fs}
                    value={props[key]}
                    patch={patch}
                    definition={definition}
                    node={node}
                    disabled={disabled}
                />
            ))}
        </div>
    );
}
