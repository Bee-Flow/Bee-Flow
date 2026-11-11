import { KIND_OPTIONS } from './actionKindCatalog';
import { actionOptions } from './actionLabels';
import ActionQuickEditor from './ActionQuickEditor';
import { addActionOfKind } from './newAction';
import { INPUT_CLS } from './panels/kit';
import useTranslation from '@/hooks/useTranslation';
import Disclosure from '@/components/shared/Disclosure';
import { getFormFields } from './actionRefs';
import { setAction } from '../state/definitionOps';
import type { AppAction, AppDefinition, AppNode } from './appDefinition';

const NEW_PREFIX = '__new:';

export interface ActionPickerProps {
    /** The action id the surface points at (empty when none). */
    value: string | undefined;
    definition: AppDefinition;
    /** The component the surface belongs to. */
    node: AppNode;
    ariaLabel: string;
    /**
     * An action was chosen or made. `nextDefinition` is the definition to build on: the one passed in for an
     * existing action, or one with the new action added, so the caller can write the id and the new action in a
     * single commit.
     */
    onPick: (actionId: string, nextDefinition: AppDefinition) => void;
    /** An edit to the picked action itself. */
    onEditDefinition: (nextDefinition: AppDefinition) => void;
    disabled?: boolean;
}

const putAction = setAction as (
    def: AppDefinition,
    actionId: string | null,
    action: AppAction,
) => { def: AppDefinition; actionId: string | null };

/**
 * Choose an action this app already has, or make a new one of any kind, for a surface that holds an action id
 * in its props (the data grid's toolbar, bulk and add-row actions). Under the select, the picked action's own
 * fields, so a new action is not an empty box that can only be filled in somewhere else.
 */
export default function ActionPicker({
    value, definition, node, ariaLabel, onPick, onEditDefinition, disabled = false,
}: ActionPickerProps) {
    const { t } = useTranslation();
    const options = actionOptions(definition, null, t);
    const action = value ? definition?.actions?.[value] : undefined;
    const formFields = getFormFields(definition, node);

    const onSelect = (picked: string) => {
        if (picked.startsWith(NEW_PREFIX)) {
            const { def, actionId } = addActionOfKind(definition, picked.slice(NEW_PREFIX.length), formFields);
            if (actionId) onPick(actionId, def);
            return;
        }
        onPick(picked, definition);
    };

    return (
        <div className="flex flex-col gap-2">
            <select
                className={INPUT_CLS}
                value={value || ''}
                onChange={(e) => onSelect(e.target.value)}
                disabled={disabled}
                aria-label={ariaLabel}
            >
                <option value="">{t('studio_apps_panels.common.pick_action', 'Pick an action…')}</option>
                {options.length ? (
                    <optgroup label={t('studio_apps_surfaces.existing_group', 'Actions this app already has')}>
                        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </optgroup>
                ) : null}
                <optgroup label={t('studio_apps_surfaces.new_group', 'Make a new action')}>
                    {KIND_OPTIONS.map((o) => (
                        <option key={o.value} value={`${NEW_PREFIX}${o.value}`}>{t(o.labelKey, o.labelEn)}</option>
                    ))}
                </optgroup>
            </select>
            {value && action ? (
                <Disclosure title={t('studio_apps_surfaces.edit_action', 'Edit this action')} defaultOpen={false}>
                    <ActionQuickEditor
                        action={action}
                        actionId={value}
                        definition={definition}
                        node={node}
                        formFields={formFields}
                        disabled={disabled}
                        onChange={(next) => {
                            const { def } = putAction(definition, value, next);
                            if (def !== definition) onEditDefinition(def);
                        }}
                    />
                </Disclosure>
            ) : null}
        </div>
    );
}
