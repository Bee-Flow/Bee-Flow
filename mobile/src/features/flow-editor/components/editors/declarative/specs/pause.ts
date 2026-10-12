/**
 * Wait and Notification — the web's WaitFields (collectionEditors.jsx) and
 * NotificationFields (actionEditors/notificationFields.jsx).
 */

import { channelLabel, channelOptionsFor, normalizeChannels, stepChannelsToUi } from '@/features/flow-editor/formState/notificationDefaults';

import { msg, type EditorSpec } from '../spec';
import { FOR_EACH, repeatsOrRetries, RETRY, TITLES } from './common';

export const WAIT: EditorSpec = {
    type: 'wait',
    sections: [
        {
            key: 'config',
            title: TITLES.configuration,
            defaultOpen: true,
            fields: [
                {
                    kind: 'duration',
                    key: 'seconds',
                    required: true,
                    label: msg('mobile.flow.wait.for', 'Wait for'),
                    hint: msg('mobile.flow.wait.hint', 'Up to 24 hours. Dry-run skips the wait.'),
                },
            ],
        },
    ],
};

/** A notification STEP delivers to the bell and email only (validate.js NOTIFICATION_STEP_CHANNELS). */
const channelOptions = () =>
    channelOptionsFor('step').map((o) => ({ value: o.key, label: channelLabel(o), fixed: o.always }));

export const NOTIFICATION: EditorSpec = {
    type: 'notification',
    sections: [
        {
            key: 'message',
            title: msg('mobile.flow.notification.message', 'Message'),
            defaultOpen: true,
            fields: [
                { kind: 'template', key: 'title', label: msg('mobile.flow.notification.title', 'Title'), example: 'New invoice received' },
                {
                    kind: 'template',
                    key: 'body',
                    multiline: true,
                    required: true,
                    label: msg('mobile.flow.notification.body', 'Body'),
                    hint: msg('mobile.flow.notification.body_hint', 'Tap Insert data to add a value from an earlier step.'),
                    example: 'From: {{trigger.output.from}}\nSubject: {{trigger.output.subject}}',
                },
                {
                    kind: 'chips',
                    id: 'channels',
                    label: msg('mobile.flow.notification.send_to', 'Send to'),
                    hint: msg(
                        'mobile.flow.notification.send_to_hint',
                        'In-app lands in the Bee Flow notification centre — the bell in the top bar. Email goes to the person this automation belongs to.',
                    ),
                    options: channelOptions,
                    read: (draft) => stepChannelsToUi(draft.channels),
                    write: (value) => ({ channels: normalizeChannels(value) }),
                },
            ],
        },
        {
            key: 'advanced',
            title: TITLES.advanced,
            defaultOpen: repeatsOrRetries,
            hasContent: repeatsOrRetries,
            fields: [FOR_EACH, RETRY],
        },
    ],
};
