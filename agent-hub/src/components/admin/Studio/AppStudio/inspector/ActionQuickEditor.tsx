import { useState } from 'react';
import { EDITOR_BY_KIND } from './actionKindCatalog';
import AiActionEditor from './AiActionEditors';
import { NavigateEditor, OpenUrlEditor, SequenceSummary, ToastEditor } from './EventWiringParts';
import { withPickedAutomation } from './eventWiring.helpers';
import AutomationPicker from './AutomationPicker';
import useTranslation from '@/hooks/useTranslation';
import Modal from '@/components/shared/Modal';
import ActionFlowEditor from '../flow/ActionFlowEditor';
import StepSettings from '../flow/StepSettings';
import type { AppAction, AppDefinition, AppNode, FormFieldRef } from './appDefinition';

export interface ActionQuickEditorProps {
    action: AppAction;
    actionId: string | null;
    definition: AppDefinition;
    /** The component the action is used from, when there is one (a grid); the Logic tab has none. */
    node?: AppNode | null;
    formFields?: FormFieldRef[];
    onChange: (next: AppAction) => void;
    disabled?: boolean;
}

/**
 * The fields of ONE action, wherever it is edited from.
 *
 * ActionsSection edits the action behind an event slot; the places that hold an action id outside a slot (the
 * data grid's toolbar, bulk and add-row actions, the Logic tab's new action) have no slot to edit it through.
 * This is the same dispatch on the kind, with the same editors, without the slot's wiring around it.
 */
export default function ActionQuickEditor({
    action, actionId, definition, node = null, formFields = [], onChange, disabled = false,
}: ActionQuickEditorProps) {
    const { t } = useTranslation();
    const [flowOpen, setFlowOpen] = useState(false);
    const [pickerOpen, setPickerOpen] = useState(false);
    const editor = EDITOR_BY_KIND[action.kind];
    const screens = definition?.screens || [];

    return (
        <div className="flex flex-col gap-3" data-action-quick-editor={action.kind}>
            {action.kind === 'sequence' ? (
                <SequenceSummary action={action} onOpen={() => setFlowOpen(true)} disabled={disabled} />
            ) : null}
            {action.kind === 'run_automation' ? (
                <>
                    <button
                        type="button"
                        onClick={() => setPickerOpen(true)}
                        disabled={disabled}
                        className="self-start rounded-md border px-2.5 py-1.5 text-xs font-medium border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    >
                        {action.automationId
                            ? t('studio_apps_surfaces.change_automation', 'Change the automation')
                            : t('studio_apps_surfaces.pick_automation', 'Pick an automation')}
                    </button>
                    <AutomationPicker
                        open={pickerOpen}
                        onClose={() => setPickerOpen(false)}
                        formFields={formFields}
                        onPick={(automation) => {
                            setPickerOpen(false);
                            onChange(withPickedAutomation(action, automation, formFields, formFields.map((f) => f.name)));
                        }}
                    />
                </>
            ) : null}
            {editor === 'ai' ? (
                <AiActionEditor action={action} commit={onChange} formFields={formFields} disabled={disabled} />
            ) : null}
            {action.kind === 'navigate' ? (
                <NavigateEditor action={action} commitAction={onChange} disabled={disabled} screens={screens} />
            ) : null}
            {action.kind === 'toast' ? <ToastEditor action={action} commitAction={onChange} disabled={disabled} /> : null}
            {action.kind === 'open_url' ? <OpenUrlEditor action={action} commitAction={onChange} disabled={disabled} /> : null}
            {editor === 'spec' ? (
                <StepSettings
                    step={action}
                    onChange={onChange}
                    definition={definition}
                    node={node}
                    screens={screens}
                    formFields={formFields}
                    actionId={actionId}
                    disabled={disabled}
                />
            ) : null}
            <Modal
                open={flowOpen}
                onClose={() => setFlowOpen(false)}
                title={t('studio_apps_insp.actions.flow_title', 'What happens, step by step')}
                description={t('studio_apps_insp.actions.flow_description', 'Each step runs in order. A branch runs only the path it takes.')}
                size="full"
            >
                {flowOpen ? (
                    <div className="h-[70vh]">
                        <ActionFlowEditor
                            action={action}
                            onChange={onChange}
                            definition={definition}
                            node={node}
                            formFields={formFields}
                            actionId={actionId}
                            disabled={disabled}
                        />
                    </div>
                ) : null}
            </Modal>
        </div>
    );
}
