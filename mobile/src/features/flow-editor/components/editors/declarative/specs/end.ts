/**
 * The steps that end a flow: Stop with an error (actionEditors/
 * stopErrorFields.jsx), Back to the app (returnToAppEditor.jsx — its words
 * are the web's own keys) and a flowlet's Return fields
 * (actionEditors/flowletCallFields.jsx LayerOutputFields).
 */

import { msg, type EditorSpec } from '../spec';
import { TITLES } from './common';

export const STOP_ERROR: EditorSpec = {
    type: 'stop_error',
    sections: [
        {
            key: 'config',
            title: TITLES.configuration,
            defaultOpen: true,
            fields: [
                {
                    kind: 'template',
                    key: 'message',
                    multiline: true,
                    example: 'Budget exceeded by {{steps.calc.output.delta}}',
                    label: msg('mobile.flow.stop.message', 'Error message'),
                    hint: msg('mobile.flow.stop.message_hint', 'Surfaced as the run error. Template-interpolated.'),
                },
            ],
        },
    ],
};

const R = 'automation_editor.return_to_app';
/** RETURN_TO_APP_TOAST_TONES and RETURN_TO_APP_REFRESH_MODES on the server. */
const TONES = ['info', 'success', 'warning', 'danger'];
const REFRESH_MODES = ['tableViews', 'resetForm'];

export const RETURN_TO_APP: EditorSpec = {
    type: 'return_to_app',
    sections: [
        {
            key: 'config',
            title: msg(`${R}.section_config`, 'What the app does next'),
            defaultOpen: true,
            fields: [
                {
                    kind: 'template',
                    key: 'toastMessage',
                    multiline: true,
                    example: 'Saved {{steps.save.output.name}}',
                    label: msg(`${R}.toast_label`, 'Message to show'),
                    hint: msg(`${R}.toast_hint`, 'A single line the visitor reads when the automation finishes. Template-interpolated.'),
                },
                {
                    kind: 'segmented',
                    key: 'toastTone',
                    visibleWhen: (draft) => !!draft.toastMessage,
                    read: (draft) => (TONES.includes(draft.toastTone as string) ? draft.toastTone : 'info'),
                    label: msg(`${R}.tone_label`, 'Tone'),
                    options: [
                        { value: 'info', label: msg(`${R}.tone_info`, 'Info') },
                        { value: 'success', label: msg(`${R}.tone_success`, 'Success') },
                        { value: 'warning', label: msg(`${R}.tone_warning`, 'Warning') },
                        { value: 'danger', label: msg(`${R}.tone_danger`, 'Problem') },
                    ],
                },
                {
                    kind: 'text',
                    key: 'navigateScreenId',
                    example: 'scr_orders',
                    label: msg(`${R}.screen_label`, 'Screen to open'),
                    hint: msg(`${R}.screen_hint`, 'The id of a screen in the app that starts this automation. Leave empty to stay where the visitor is.'),
                },
                {
                    kind: 'template',
                    key: 'navigateRecordRef',
                    example: '{{steps.save.output.id}}',
                    visibleWhen: (draft) => !!draft.navigateScreenId,
                    label: msg(`${R}.record_label`, 'Record to open'),
                    hint: msg(`${R}.record_hint`, 'The id the screen should show. Reaches it as screen.params.id.'),
                },
                {
                    kind: 'select',
                    key: 'refresh',
                    read: (draft) => (REFRESH_MODES.includes(draft.refresh as string) ? draft.refresh : ''),
                    label: msg(`${R}.refresh_label`, 'Refresh'),
                    hint: msg(`${R}.refresh_hint`, 'What the app reloads once the run is done.'),
                    options: [
                        { value: '', label: msg(`${R}.refresh_none`, 'Nothing') },
                        { value: 'tableViews', label: msg(`${R}.refresh_tables`, 'Reload the data on screen') },
                        { value: 'resetForm', label: msg(`${R}.refresh_form`, 'Clear the form that started this') },
                    ],
                },
            ],
        },
        {
            key: 'advanced',
            title: msg(`${R}.section_advanced`, 'Advanced'),
            hasContent: (draft) => draft.onError === 'errorScreen',
            fields: [
                {
                    kind: 'select',
                    key: 'onError',
                    label: msg(`${R}.on_error_label`, 'If the app cannot do this'),
                    hint: msg(`${R}.on_error_hint`, 'When the screen no longer exists, or there is no form to clear. Staying put is the safe answer.'),
                    options: [
                        { value: 'stay', label: msg(`${R}.on_error_stay`, 'Stay on the current screen') },
                        { value: 'errorScreen', label: msg(`${R}.on_error_screen`, 'Show the app’s error screen') },
                    ],
                },
            ],
        },
    ],
};

export const LAYER_OUTPUT: EditorSpec = {
    type: 'layer_output',
    sections: [
        {
            key: 'fields',
            title: msg('mobile.flow.layer_output.title', 'Return fields'),
            intro: msg(
                'mobile.flow.layer_output.hint',
                'The object this flowlet returns to its caller. Bind each field to a value produced inside the flowlet.',
            ),
            defaultOpen: true,
            fields: [{ kind: 'rows', key: 'fields', keepEmpty: true }],
        },
    ],
};
