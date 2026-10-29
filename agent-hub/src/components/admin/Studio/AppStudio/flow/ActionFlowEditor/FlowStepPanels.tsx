import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { paletteGroups, stepMeta } from '../stepCatalog';
import type { StepNode } from '../stepGraph';
import StepSettings from '../StepSettings';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import IconButton from '@/components/shared/IconButton';
import NodeContextMenu from '@/components/automation/Builder/flow/NodeContextMenu';
import type { BandItem } from '@/components/automation/Builder/flow/rowBands';
import type { StepPaletteProps } from '../ActionFlowEditor.types';

// The side panel of the action flow editor: the selected step, the empty state, and the step palette.

type SettingsProps = ComponentProps<typeof StepSettings>;

interface SelectedStepPanelProps {
    t: TranslateFn;
    selected: StepNode;
    disabled: boolean;
    canMoveEarlier: boolean;
    canMoveLater: boolean;
    onMove: (delta: number) => void;
    onRemove: () => void;
    onPatch: SettingsProps['onChange'];
    definition: SettingsProps['definition'];
    node: SettingsProps['node'];
    screens: SettingsProps['screens'];
    formFields: SettingsProps['formFields'];
}

/** The selected step: its name, move earlier/later and delete, and its settings. */
export function SelectedStepPanel({
    t, selected, disabled, canMoveEarlier, canMoveLater, onMove, onRemove, onPatch, definition, node, screens, formFields,
}: SelectedStepPanelProps) {
    return (
        <div className="flex flex-col gap-3">
            <header className="flex items-center gap-2">
                <h3 className="flex-1 text-sm font-semibold text-[var(--text-primary)]">
                    {stepMeta(selected.kind, t).label}
                </h3>
                <IconButton
                    ariaLabel={t('studio_apps_edit.action_flow.move_earlier', 'Move this step earlier')}
                    size="sm"
                    disabled={disabled || !canMoveEarlier}
                    onClick={() => onMove(-1)}
                >
                    <ChevronUp />
                </IconButton>
                <IconButton
                    ariaLabel={t('studio_apps_edit.action_flow.move_later', 'Move this step later')}
                    size="sm"
                    disabled={disabled || !canMoveLater}
                    onClick={() => onMove(1)}
                >
                    <ChevronDown />
                </IconButton>
                <IconButton
                    ariaLabel={t('studio_apps_edit.action_flow.delete_step', 'Delete this {kind} step', { kind: stepMeta(selected.kind, t).label.toLowerCase() })}
                    variant="danger"
                    size="sm"
                    disabled={disabled}
                    onClick={onRemove}
                >
                    <Trash2 />
                </IconButton>
            </header>
            <StepSettings
                step={selected.step}
                onChange={onPatch}
                definition={definition}
                node={node}
                screens={screens}
                formFields={formFields}
                disabled={disabled}
            />
        </div>
    );
}

/** Nothing selected: say how, and offer Add a step. */
export function PickOrAddStep({ t, disabled, onAdd }: { t: TranslateFn; disabled: boolean; onAdd: () => void }) {
    return (
        <div className="flex flex-col gap-2">
            <p className="text-xs text-[var(--text-secondary)]">
                {t('studio_apps_edit.action_flow.pick_or_add', 'Pick a step to change it, or add one to the end.')}
            </p>
            <button
                type="button"
                onClick={onAdd}
                disabled={disabled}
                className="self-start inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-dashed border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
            >
                <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('studio_apps_edit.action_flow.add_step', 'Add a step')}
            </button>
        </div>
    );
}

export function StepPalette({ onPick, onCancel }: StepPaletteProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-3">
            <header className="flex items-center gap-2">
                <h3 className="flex-1 text-sm font-semibold text-[var(--text-primary)]">{t('studio_apps_edit.action_flow.add_step', 'Add a step')}</h3>
                <button
                    type="button"
                    onClick={onCancel}
                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)] rounded px-1"
                >
                    {t('studio_apps_edit.action_flow.cancel', 'Cancel')}
                </button>
            </header>
            {paletteGroups(t).map(({ group, label: groupName, kinds }) => (
                <div key={group} className="flex flex-col gap-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">{groupName}</span>
                    {kinds.map(({ kind, label, blurb, icon: Icon }) => (
                        <button
                            key={kind}
                            type="button"
                            onClick={() => onPick(kind)}
                            className="flex items-start gap-2 text-left rounded-md border border-[var(--border-subtle)] px-2 py-1.5 hover:bg-[var(--bg-tertiary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]"
                        >
                            <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
                            <span className="min-w-0">
                                <span className="block text-xs font-medium text-[var(--text-primary)]">{label}</span>
                                <span className="block text-[11px] text-[var(--text-secondary)]">{blurb}</span>
                            </span>
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}

interface StepContextMenuProps {
    menu: BandItem;
    disabled: boolean;
    onDuplicate: (id: string) => void;
    onDelete: (id: string) => void;
    onClose: () => void;
}

/** The automation builder's own right-click menu, on one step. */
export function StepContextMenu({ menu, disabled, onDuplicate, onDelete, onClose }: StepContextMenuProps) {
    return (
        <NodeContextMenu
            x={menu.x}
            y={menu.y}
            canDelete={!disabled}
            canDuplicate={!disabled}
            onDuplicate={() => onDuplicate(menu.id)}
            onDelete={() => onDelete(menu.id)}
            onClose={onClose}
        />
    );
}
