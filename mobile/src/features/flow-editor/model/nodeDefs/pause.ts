/**
 * The pause family: every step that waits for a clock or a person, or tells
 * one something.
 *
 * Data copied from the web builder's flow/nodeDefs.js; nodeDefs.lockstep.test.ts
 * requires the web module and compares every record, so a changed word fails.
 * The palette wording is `labelFallback` here (the English under the
 * `automations.node.<type>.label` key; ./index.ts serves it as `label`), and a
 * quoted issue-map key is a validation path segment, not copy.
 */

import { FLAT, type NodeDefSource } from './types';

export const PAUSE_DEFS: Record<string, NodeDefSource> = {
    wait: {
        family: 'pause',
        typeLabel: 'Wait',
        defaultLabel: 'Wait',
        desc: 'Pause before the next step — seconds, minutes or hours',
        help: 'Holds the run here for a set time, then carries on. Up to 24 hours. Other branches run first and finish before the wait starts, but they cannot run during it — two waits happen one after the other, and any slow step still holds up the rest of the run.',
        sectionKeys: ['config'],
        simpleSections: ['config'],
        issueSections: { fallback: 'config', map: { label: FLAT, seconds: 'config' } },
        labelFallback: 'Wait',
    },
    notification: {
        family: 'pause',
        typeLabel: 'Notification',
        defaultLabel: 'Notification',
        desc: 'Send a message or alert',
        help: 'Sends a message to you or your team while the run is going — by in-app notification or email.',
        sectionKeys: ['message', 'advanced'],
        simpleSections: ['message'],
        issueSections: {
            fallback: 'message',
            map: {
                label: FLAT,
                'title': 'message',
                body: 'message',
                inputs: 'message',
                channels: 'message',
                forEach: 'advanced',
            },
        },
        labelFallback: 'Notification',
    },
    form_page: {
        family: 'pause',
        typeLabel: 'Form page',
        defaultLabel: 'Ask for more info',
        help: 'Pauses the run and shows another page on the automation’s own form link, then continues with the answers.',
        sectionKeys: ['config', 'waiting'],
        simpleSections: ['config', 'waiting'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, mode: 'config', form: 'config', waitSeconds: 'waiting' },
        },
    },
    approval: {
        family: 'pause',
        typeLabel: 'Approval',
        defaultLabel: 'Approval',
        desc: 'Pause the run until a person approves or rejects it',
        help: 'Pauses the run and asks a person to approve or reject it. Approve and the run carries on from the next step; reject and the run stops here.',
        sectionKeys: ['config', 'waiting'],
        simpleSections: ['config', 'waiting'],
        issueSections: {
            fallback: 'config',
            map: { label: FLAT, prompt: 'config', approval: 'waiting', forEach: 'waiting' },
        },
        labelFallback: 'Ask someone to approve',
    },
};
