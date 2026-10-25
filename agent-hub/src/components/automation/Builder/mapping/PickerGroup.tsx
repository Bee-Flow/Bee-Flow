import { ChevronDown, ChevronRight } from 'lucide-react';
import React, { useState } from 'react';
import { canonicalRefPath } from '../../../../utils/bindingHelpers';
import { useTranslation } from '../../../../hooks/useTranslation';
import { listBadgeClass } from '../flow/settings/formStyles';
import { startPathDrag } from './bindingDnd';
import { fieldListShape } from './listShape';
import { humanizeFieldKey } from '../flow/displayHelpers';
import { friendlyBasePath } from './VariableTree';
import { fieldLabelText } from './upstream/routeFieldLabel';
import type { GroupField } from './deepFields';
import type { PickerGroupProps, PickerLeafProps, LeafTextProps } from './VariablePicker.types';
import { leafValueText } from './VariablePicker.helpers';

export function PickerGroup({ group, onPick, onHoverField, previewSample = null, currentPath = '', searching = false }: PickerGroupProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(true);
    const caption = friendlyBasePath(group.basePath, group.label);
    return (
        <div className="border-b border-[var(--border-default)] last:border-b-0">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                // The base path lives on the header itself, so it stays one
                // hover away even for a group whose caption is dropped as a
                // stutter of its own label.
                title={group.basePath}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-[var(--bg-secondary)]"
            >
                {open
                    ? <ChevronDown size={12} className="text-[var(--text-tertiary)]" />
                    : <ChevronRight size={12} className="text-[var(--text-tertiary)]" />}
                <span className="text-[var(--text-primary)] font-medium truncate">{group.label}</span>
                {/* This popover is the control that exists so nobody has to know
                    the path — and it led with one, in monospace, id and all
                    (`steps.act_4d3307a.output`). The caption now says it in
                    words, exactly as VariableTree's group row does; the raw
                    base path stays in the `title`, because it is still the
                    string a power user copies into an expression. Demote it,
                    never delete it. */}
                {caption && (
                    <span
                        className="ml-auto text-[10px] text-[var(--text-tertiary)] truncate max-w-[140px]"
                        title={group.basePath}
                    >
                        {caption}
                    </span>
                )}
            </button>
            {open && (group.fields || []).length === 0 && (
                <div className="px-6 py-1 text-[11px] text-[var(--text-tertiary)] italic">{t('automations.variable_picker.no_fields', 'No fields')}</div>
            )}
            {open && (group.fields || []).map(f => (
                <PickerLeaf
                    key={f.path}
                    field={f}
                    depth={1}
                    onPick={onPick}
                    onHoverField={onHoverField}
                    previewSample={previewSample}
                    currentPath={currentPath}
                    searching={searching}
                />
            ))}
        </div>
    );
}

function PickerLeaf({ field, depth, onPick, onHoverField, previewSample = null, currentPath = '', searching = false }: PickerLeafProps) {
    // null = the author has not toggled this row: closed normally, OPEN while
    // searching, so a match deep in a list ("address" under Value ▸ From ▸
    // Email address) is on screen rather than behind a collapsed parent.
    const [toggled, setToggled] = useState<boolean | null>(null);
    // By meaning, not spelling: the pill may say `['k']`, the tree `["k"]`.
    const isCurrent = !!currentPath && canonicalRefPath(field.path) === canonicalRefPath(currentPath);
    const hasChildren = Array.isArray(field.children) && field.children.length > 0;
    const expanded = toggled ?? (searching && hasChildren);
    const setExpanded = (fn: (open: boolean) => boolean) => setToggled(fn(expanded));
    const indent = 12 + depth * 14;
    // Announce a list before it is picked, with the TRUE flattened count —
    // `field.sample` for a `[*]` path is the first ELEMENT, so counts read
    // from it were simply wrong.
    const shape = fieldListShape(field, previewSample);

    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (hasChildren && (e.target as Element).closest('[data-expand-btn]')) {
            setExpanded(o => !o);
            return;
        }
        onPick?.(field.path, { raw: e.altKey });
    };

    return (
        <>
            <div
                role="button"
                tabIndex={0}
                // Also a DRAG SOURCE. Every field editor in both builders already
                // accepts an `application/x-binding-path` drop, but the only
                // element that ever produced one was VariableTree's row — a panel
                // App Studio never renders, so its drop targets were unreachable
                // there. One attribute here makes them live in both.
                draggable
                onDragStart={(e) => startPathDrag(e, field.path)}
                onClick={handleClick}
                onMouseEnter={() => onHoverField(field)}
                onMouseLeave={() => onHoverField(null)}
                onFocus={() => onHoverField(field)}
                onBlur={() => onHoverField(null)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onPick?.(field.path, { raw: e.altKey });
                    }
                }}
                aria-current={isCurrent ? 'true' : undefined}
                className={`group flex items-center gap-2 py-1 text-[11px] cursor-pointer select-none hover:bg-[var(--bg-secondary)] focus:bg-[var(--bg-secondary)] focus:outline-none ${isCurrent ? 'bg-[var(--bg-tertiary)] font-semibold' : ''}`}
                style={{ paddingLeft: indent, paddingRight: 8 }}
                title={field.path}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        data-expand-btn
                        onClick={(e) => { e.stopPropagation(); setExpanded(o => !o); }}
                        className="shrink-0 p-0.5 -m-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                    >
                        {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                ) : (
                    <span className="shrink-0 w-3" />
                )}
                {/* The name of the thing, not its key: "Klant naam", never
                    `klant_naam` (displayHelpers.humanizeFieldKey — the same
                    humaniser the Condition field picker uses). The exact key
                    keeps its own `title` here and the whole row still carries
                    the full dotted path, so the one string an expression needs
                    is one hover away. */}
                <LeafText field={field} shape={shape} previewSample={previewSample} hasChildren={hasChildren} />
            </div>
            {hasChildren && expanded && field.children?.map((c: GroupField) => (
                <PickerLeaf
                    key={c.path}
                    field={c}
                    depth={depth + 1}
                    onPick={onPick}
                    onHoverField={onHoverField}
                    previewSample={previewSample}
                    currentPath={currentPath}
                    searching={searching}
                />
            ))}
        </>
    );
}

function LeafText({ field, shape, previewSample, hasChildren }: LeafTextProps) {
    const { t } = useTranslation();
    return (
        <>
            <span className="text-[var(--text-primary)] truncate shrink-0 max-w-[60%]" title={field.key} data-picker-name="">
                {fieldLabelText(field, t) ?? (humanizeFieldKey(field.key) || field.key)}
            </span>
            {shape && (
                <span className={listBadgeClass()} title={t(shape.explainKey, shape.explainEn, shape.explainParams)}>
                    {shape.count != null ? `${t('automations.builder.list_word', 'list')} · ${shape.count}` : t('automations.builder.list_word', 'list')}
                </span>
            )}
            <span className="ml-auto min-w-0 text-right text-[10px] text-[var(--text-tertiary)] truncate">
                {leafValueText(field, previewSample, t, hasChildren)}
            </span>
        </>
    );
}
