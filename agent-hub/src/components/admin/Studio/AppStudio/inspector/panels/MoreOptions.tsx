import { useCatalogComponents, SpecPropRow } from './SpecPanel';
import type { ReactNode } from 'react';
import { ItemField } from './SpecListField';
import { usePatch } from './kit';
import { planMoreOptions, nestedPath } from './moreOptionsPlan';
import { humanize, isClearedProp, itemTitle, setItemKey } from './specProps';
import useTranslation from '@/hooks/useTranslation';
import Disclosure from '@/components/shared/Disclosure';
import type { ListPlan } from './moreOptionsPlan';
import type { ListItem, PropSpec } from './specProps';
import type { PanelCoverage } from '../registry';
import type { AppDefinition, AppNode } from '../appDefinition';

/**
 * "More options": the props of a component that its bespoke Content panel
 * does not edit itself, drawn from the catalog spec with the generic controls
 * (SpecPanel). For a list the panel does edit, the item keys its own editor
 * leaves out are offered per existing item, so a table column's alignment or
 * value→tone map is reachable without a second column editor. A prop added to
 * the spec later appears here by itself.
 */

interface MoreOptionsProps {
    node: AppNode;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    coverage: PanelCoverage;
    disabled?: boolean;
}

interface ExtrasProps {
    plan: ListPlan;
    items: ListItem[];
    onChange: (items: ListItem[]) => void;
    definition: AppDefinition;
    node: AppNode;
}

/** A list prop's items as stored (an entry that is not an object is kept, and skipped when drawn). */
function asItems(value: unknown): ListItem[] {
    return Array.isArray(value) ? value as ListItem[] : [];
}

function isItem(value: unknown): value is ListItem {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The left-over keys of one item, each with its own control. */
function ItemExtras({ path, keys, shape, item, update, definition, node }: {
    path: string;
    keys: string[];
    shape: Record<string, PropSpec>;
    item: ListItem;
    update: (next: ListItem) => void;
    definition: AppDefinition;
    node: AppNode;
}) {
    return (
        <>
            {keys.map((k) => (
                <div key={k} data-more-item={`${path}[].${k}`}>
                    <ItemField
                        itemKey={k}
                        fs={shape[k]}
                        value={item[k]}
                        onChange={(v) => update(setItemKey(item, k, shape[k], v))}
                        definition={definition}
                        node={node}
                    />
                </div>
            ))}
        </>
    );
}

function ItemBox({ title, children }: { title: string; children: ReactNode }) {
    return (
        <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
            <div className="text-xs font-medium text-[var(--text-secondary)] truncate">{title}</div>
            {children}
        </div>
    );
}

/** One list the panel edits: per existing item, the keys its own editor leaves out. */
function ListExtras({ plan, items, onChange, definition, node }: ExtrasProps) {
    const { t } = useTranslation();
    const shape = plan.fs.itemShape || {};
    const list = humanize(plan.key);
    const replace = (i: number, next: ListItem) => onChange(items.map((it, j) => (j === i ? next : it)));
    return (
        <div className="flex flex-col gap-2" data-more-list={plan.key}>
            <div className="text-xs font-medium text-[var(--text-secondary)]">
                {t('studio_apps_more_options.per_item', '{list}: more per item', { list })}
            </div>
            {items.length === 0 ? (
                <p className="text-[11px] text-[var(--text-muted)]">{t('studio_apps_more_options.no_items', 'Add one under {list} above first.', { list })}</p>
            ) : null}
            {items.map((item, i) => (isItem(item) ? (
                <ItemBox key={i} title={itemTitle(item, shape) || `#${i + 1}`}>
                    <ItemExtras path={plan.key} keys={plan.extraKeys} shape={shape} item={item} update={(next) => replace(i, next)} definition={definition} node={node} />
                    {plan.nested.map((n) => {
                        const subShape = n.fs.itemShape || {};
                        const subs = asItems(item[n.key]);
                        const replaceSub = (j: number, next: ListItem) => replace(i, { ...item, [n.key]: subs.map((s, k) => (k === j ? next : s)) });
                        return subs.map((sub, j) => (isItem(sub) ? (
                            <ItemBox key={`${n.key}-${j}`} title={`${humanize(n.key)} · ${itemTitle(sub, subShape) || `#${j + 1}`}`}>
                                <ItemExtras path={nestedPath(plan.key, n.key)} keys={n.extraKeys} shape={subShape} item={sub} update={(next) => replaceSub(j, next)} definition={definition} node={node} />
                            </ItemBox>
                        ) : null));
                    })}
                </ItemBox>
            ) : null))}
        </div>
    );
}

/** True when a prop or item key in the block already holds a value, so it opens by itself. */
function holdsValues(plan: ReturnType<typeof planMoreOptions>, specProps: Record<string, PropSpec>, props: Record<string, unknown>) {
    if (plan.props.some((k) => !isClearedProp(specProps[k], props[k]))) return true;
    return plan.lists.some((l) => asItems(props[l.key]).some((item) => isItem(item) && l.extraKeys.some((k) => item[k] !== undefined)));
}

export default function MoreOptions({ node, definition, onCommit, coverage, disabled = false }: MoreOptionsProps) {
    const { t } = useTranslation();
    const catalog = useCatalogComponents();
    const patch = usePatch(node, definition, onCommit);
    const specProps: Record<string, PropSpec> | undefined = catalog?.[node.type]?.props;
    if (!specProps) return null;
    const plan = planMoreOptions(specProps, coverage);
    if (!plan.props.length && !plan.lists.length) return null;
    const props = (node.props || {}) as Record<string, unknown>;
    return (
        <div className="mt-4 pt-3 border-t border-[var(--border-subtle)]" data-more-options={node.type}>
            <Disclosure
                title={t('studio_apps_more_options.title', 'More options')}
                hint={String(plan.props.length + plan.lists.length)}
                defaultOpen={holdsValues(plan, specProps, props)}
            >
                <fieldset disabled={disabled} className="min-w-0 flex flex-col gap-4">
                    {plan.props.map((key) => (
                        <SpecPropRow
                            key={key}
                            propKey={key}
                            fs={specProps[key]}
                            value={props[key]}
                            patch={patch}
                            definition={definition}
                            node={node}
                            disabled={disabled}
                            describe
                        />
                    ))}
                    {plan.lists.map((l) => (
                        <ListExtras
                            key={l.key}
                            plan={l}
                            items={asItems(props[l.key])}
                            onChange={(items) => patch({ [l.key]: items })}
                            definition={definition}
                            node={node}
                        />
                    ))}
                </fieldset>
            </Disclosure>
        </div>
    );
}
