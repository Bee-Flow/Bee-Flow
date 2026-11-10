import { ChevronDown, Plus } from 'lucide-react';
import { useState } from 'react';
import { KIND_OPTIONS } from '../inspector/actionKindCatalog';
import ActionQuickEditor from '../inspector/ActionQuickEditor';
import { addActionOfKind } from '../inspector/newAction';
import { setAction } from '../state/definitionOps';
import useTranslation from '@/hooks/useTranslation';
import Modal from '@/components/shared/Modal';
import type { AppAction, AppDefinition } from '../inspector/appDefinition';

interface NewActionMenuProps {
    definition: AppDefinition;
    onCommit: (next: AppDefinition) => void;
    /** run_automation keeps its own flow (the automation picker); the tab opens it. */
    onPickAutomation: () => void;
    disabled?: boolean;
}

const putAction = setAction as (
    def: AppDefinition,
    actionId: string | null,
    action: AppAction,
) => { def: AppDefinition; actionId: string | null };

/**
 * "Add an action" on the Logic tab makes an action of every kind, a flow (sequence) included, not only an automation.
 * The action is created with the kind's own defaults and opened right away to fill in; nothing points at it
 * until a component is wired to it, so it shows as an unwired row, the same as an added automation.
 */
export default function NewActionMenu({ definition, onCommit, onPickAutomation, disabled = false }: NewActionMenuProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [editingId, setEditingId] = useState<string | null>(null);
    const editing = editingId ? definition?.actions?.[editingId] : undefined;

    const create = (kind: string) => {
        setOpen(false);
        if (kind === 'run_automation') { onPickAutomation(); return; }
        const { def, actionId } = addActionOfKind(definition, kind);
        if (!actionId) return;
        onCommit(def);
        setEditingId(actionId);
    };

    return (
        <div className="relative">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                disabled={disabled}
                aria-haspopup="menu"
                aria-expanded={open}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]"
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_surfaces.add_action', 'Add an action')}
                <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
            {open ? (
                <ul
                    role="menu"
                    className="absolute right-0 z-20 mt-1 w-56 rounded-md border p-1 shadow-lg border-[var(--border-default)] bg-[var(--bg-primary)]"
                >
                    {KIND_OPTIONS.map((o) => (
                        <li key={o.value} role="none">
                            <button
                                type="button"
                                role="menuitem"
                                onClick={() => create(o.value)}
                                className="w-full rounded px-2 py-1.5 text-left text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                            >
                                {t(o.labelKey, o.labelEn)}
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            <Modal
                open={!!editing}
                onClose={() => setEditingId(null)}
                title={t('studio_apps_surfaces.new_action_title', 'New action')}
                description={t(
                    'studio_apps_surfaces.new_action_desc',
                    'Fill it in now. Nothing runs it until you wire a component to it.',
                )}
                size="lg"
            >
                {editing && editingId ? (
                    <ActionQuickEditor
                        action={editing}
                        actionId={editingId}
                        definition={definition}
                        onChange={(next) => {
                            const { def } = putAction(definition, editingId, next);
                            if (def !== definition) onCommit(def);
                        }}
                    />
                ) : null}
            </Modal>
        </div>
    );
}
