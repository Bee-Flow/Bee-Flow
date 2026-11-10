import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import BindingField from './BindingField';
import ExpressionInput from '../logic/ExpressionInput';
import { TextField, TextAreaField, IconField, INPUT_CLS, usePatch } from './kit';
import { SpecListField } from './SpecListField';
import { clearedPropValue, firstSentence, humanize, isClearedProp, isLateEntry } from './specProps';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import Toggle from '@/components/shared/Toggle';
import { inputCls } from '@/components/admin/product-website/fields';
import { deepEqual } from '@/utils/deepEqual';
import { getComponentEntry } from '../../runtime/componentRegistry';
import { studioAppsApi } from '../../studioAppsApi';
import type { ListItem, PropSpec } from './specProps';
import type { BindingInput } from '../../runtime/resolveBinding.types';
import type { AppNode, AppDefinition, PanelProps } from '../appDefinition';

/**
 * SpecPanel — the GENERIC inspector Content panel, rendered from the server
 * catalog's prop specs (GET /api/studio-apps/catalog — componentSpecs.js
 * verbatim). Any component type without a bespoke panel falls back to this
 * (see registry.getInspectorForType), so a new catalog type gets a working
 * inspector for free instead of a silent editing gap. The same controls fill
 * the "More options" block under a bespoke panel (MoreOptions.tsx).
 *
 * Prop-type → control mapping:
 *   string/url    → text field          markdown → textarea
 *   number/int    → number field        boolean  → toggle
 *   enum          → select              icon     → icon field
 *   binding       → BindingField        formula  → ExpressionInput
 *   list          → SpecListField over itemShape (every item key, nested
 *                   lists, bindings and icons included)
 *   stringList    → comma-separated text field
 *
 * A prop that holds something other than what a node without it would hold
 * shows a "Reset" link, which writes back exactly that (specProps.clearedPropValue).
 *
 * The catalog is fetched once and cached for the session (react-query,
 * staleTime Infinity). If it is unavailable (offline draft), a minimal spec
 * is inferred from the registry's defaultProps so basic editing still works.
 */

const CATALOG_QUERY_KEY = ['studio-apps', 'catalog'];

function useCatalog() {
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

/** Offline fallback: infer a minimal prop spec from registry defaultProps. */
function inferSpecProps(defaultProps: Record<string,unknown>|undefined) {
    const out: Record<string, PropSpec> = {};
    for (const [key, v] of Object.entries(defaultProps || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && 'kind' in v) out[key] = { type: 'binding', default: v };
        else if (typeof v === 'boolean') out[key] = { type: 'boolean', default: v };
        else if (typeof v === 'number') out[key] = { type: 'number', default: v };
        else if (Array.isArray(v)) out[key] = { type: 'list', itemShape: null, default: [] };
        else out[key] = { type: 'string', default: v };
    }
    return out;
}

/** The value a control hands over, as the definition should hold it. */
function normalizeCommit(fs: PropSpec, value: unknown) {
    // A late prop is only written while it holds something other than its
    // default: an empty text, the default value or null all mean "not set".
    if (isLateEntry(fs) && (value === '' || value === undefined || deepEqual(value, fs.default ?? null))) return null;
    return value;
}

/** Clamp a typed number to the spec range (and to an integer for `int`). */
function clampNumber(fs: PropSpec, raw: number) {
    let n = fs.type === 'int' ? Math.round(raw) : raw;
    if (typeof fs.min === 'number' && Number.isFinite(fs.min) && n < fs.min) n = fs.min;
    if (typeof fs.max === 'number' && Number.isFinite(fs.max) && n > fs.max) n = fs.max;
    return n;
}

interface SpecNumberFieldProps {
    label: string;
    fs: PropSpec;
    value: unknown;
    commit: (v: unknown) => void;
    disabled: boolean;
}

/**
 * A number prop. While the box is being typed in it shows what was typed, and
 * every valid number is committed at once; a box left empty commits the
 * cleared value when it loses focus, so wiping the field to type a new number
 * does not snap back to the default in between.
 */
function SpecNumberField({ label, fs, value, commit, disabled }: SpecNumberFieldProps) {
    const [draft, setDraft] = useState<string | null>(null);
    const ranged = typeof fs.min === 'number' && typeof fs.max === 'number' && Number.isFinite(fs.min) && Number.isFinite(fs.max);
    return (
        <FormField label={label} hint={ranged ? `${fs.min}–${fs.max}` : undefined}>
            <input
                type="number"
                className={INPUT_CLS}
                value={draft ?? (value == null ? '' : String(value))}
                step={fs.type === 'int' ? 1 : 'any'}
                onChange={(e) => {
                    const text = e.target.value;
                    setDraft(text);
                    const n = Number(text);
                    if (text !== '' && Number.isFinite(n)) commit(clampNumber(fs, n));
                }}
                onBlur={() => {
                    if (draft === '') commit(clearedPropValue(fs));
                    setDraft(null);
                }}
                disabled={disabled}
                aria-label={label}
            />
        </FormField>
    );
}

interface SpecFieldProps {
    propKey: string;
    fs: PropSpec;
    value: unknown;
    patch: (p: Record<string, unknown>) => void;
    definition: AppDefinition;
    node: AppNode;
    disabled: boolean;
}

function SpecEnumField({ label, fs, value, commit, disabled }: Omit<SpecNumberFieldProps, 'fs'> & { fs: PropSpec }) {
    const { t } = useTranslation();
    const values = fs.values || [];
    // A late enum is absent until set: offer that state as its own option.
    const offerUnset = isLateEntry(fs) && !values.includes(null);
    return (
        <FormField label={label}>
            <select
                className={inputCls}
                value={value == null ? '' : String(value)}
                onChange={(e) => commit(e.target.value === '' ? null : e.target.value)}
                disabled={disabled}
                aria-label={label}
            >
                {offerUnset ? <option value="">{t('studio_apps_panels.spec.default_option', '(default)')}</option> : null}
                {values.map((v) => (
                    <option key={String(v)} value={v == null ? '' : String(v)}>{v === null ? t('studio_apps_panels.spec.default_option', '(default)') : String(v)}</option>
                ))}
            </select>
        </FormField>
    );
}

/** One prop → one control. */
function SpecField({ propKey, fs, value, patch, definition, node, disabled }: SpecFieldProps) {
    const { t } = useTranslation();
    const label = humanize(propKey);
    const commit = (v: unknown) => patch({ [propKey]: normalizeCommit(fs, v) });

    switch (fs.type) {
        case 'binding':
            return (
                <BindingField
                    label={label}
                    value={value as BindingInput}
                    onChange={commit}
                    definition={definition}
                    node={node}
                    disabled={disabled}
                />
            );
        case 'markdown':
            return <TextAreaField label={label} value={value == null ? undefined : String(value)} onChange={(v) => commit(v)} rows={5} disabled={disabled} />;
        case 'icon':
            return <IconField label={label} value={value == null ? null : String(value)} onChange={commit} disabled={disabled} />;
        case 'number':
        case 'int':
            return <SpecNumberField label={label} fs={fs} value={value} commit={commit} disabled={disabled} />;
        case 'boolean': {
            const checked = value === undefined || value === null ? fs.default === true : !!value;
            return <Toggle label={label} checked={checked} onChange={(v) => commit(v)} disabled={disabled} size="sm" />;
        }
        case 'enum':
            return <SpecEnumField label={label} fs={fs} value={value} commit={commit} disabled={disabled} />;
        case 'list': {
            if (!fs.itemShape) return null; // inferred fallback list — needs the real catalog
            return (
                <SpecListField
                    label={label}
                    itemShape={fs.itemShape}
                    maxItems={fs.maxItems}
                    items={Array.isArray(value) ? value : undefined}
                    onChange={(items: ListItem[]) => commit(items)}
                    disabled={disabled}
                    definition={definition}
                    node={node}
                />
            );
        }
        case 'stringList':
            return (
                <TextField
                    label={label}
                    value={Array.isArray(value) ? value.join(', ') : (value == null ? '' : String(value))}
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
                    <ExpressionInput
                        value={value ? String(value) : ''}
                        onChange={(v) => commit(v || null)}
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
                    value={value == null ? undefined : String(value)}
                    onChange={(v) => commit(v === '' && fs.default === null ? null : v)}
                    placeholder={fs.type === 'url' ? 'https://…' : (typeof fs.default === 'string' ? fs.default : undefined)}
                    disabled={disabled}
                />
            );
    }
}

/**
 * A prop's control, its one-line description from the catalog, and a Reset
 * link while it holds something a node without it would not.
 */
export function SpecPropRow(props: SpecFieldProps & { describe?: boolean }) {
    const { t } = useTranslation();
    const { propKey, fs, value, patch, disabled, describe = false } = props;
    const gloss = describe ? firstSentence(fs.description) : undefined;
    return (
        <div className="flex flex-col gap-1" data-spec-prop={propKey}>
            <SpecField {...props} />
            {gloss ? <p className="text-[11px] text-[var(--text-muted)]">{gloss}</p> : null}
            {isClearedProp(fs, value) ? null : (
                <button
                    type="button"
                    className="self-start text-[11px] text-[var(--text-secondary)] hover:underline disabled:opacity-50"
                    onClick={() => patch({ [propKey]: clearedPropValue(fs) })}
                    disabled={disabled}
                    aria-label={t('studio_apps_more_options.reset_aria', 'Reset {name}', { name: humanize(propKey) })}
                >
                    {t('studio_apps_more_options.reset', 'Reset')}
                </button>
            )}
        </div>
    );
}

export default function SpecPanel({ node, definition, onCommit, disabled = false }: PanelProps) {
    const props = node.props || {};
    const patch = usePatch(node, definition, onCommit);
    const catalog = useCatalogComponents();

    const propSpecs: Record<string, PropSpec> = catalog?.[node.type]?.props
        || inferSpecProps(getComponentEntry(node.type)?.defaultProps);
    const entries = Object.entries(propSpecs || {});
    if (!entries.length) return null;

    return (
        <div className="flex flex-col gap-4" data-spec-panel={node.type}>
            {entries.map(([key, fs]) => (
                <SpecPropRow
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
