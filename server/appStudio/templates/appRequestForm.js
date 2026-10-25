// @typecheck noImplicitAny
/**
 * App Studio template — Request form — the canonical v1 demo: form → automation → thanks.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-request-form',
    version: 1,
    title: 'Request form',
    description: 'Collect requests with a simple form that hands each submission to one of your Automations, then shows a thank-you screen.',
    category: 'Forms',
    icon: 'ClipboardList',
    tags: ['form', 'intake', 'requests'],
    definition: {
        schemaVersion: 1,
        meta: { name: 'Request form', description: 'Submit a request to the team.', icon: 'ClipboardList' },
        theme: { primary: '#0F766E', ...THEME_DEFAULTS },
        homeScreenId: 'scr_reqhome',
        screens: [
            {
                id: 'scr_reqhome',
                name: 'New request',
                icon: 'ClipboardList',
                showInNav: true,
                maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_reqintro',
                        style: { padding: 4, gap: 2, background: 'none' },
                        children: [
                            { id: 'cmp_reqtitle', type: 'heading', props: { text: 'Submit a request', level: 1 }, style: { span: 12 }, visible: true },
                            { id: 'cmp_reqlead', type: 'text', props: { text: 'Fill in the details below and the team will pick it up.', muted: true }, style: { span: 12 }, visible: true },
                        ],
                    },
                    {
                        id: 'sec_reqform',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_reqfrm',
                                type: 'form',
                                props: { name: 'request', submitLabel: 'Send request', showReset: false },
                                style: { span: 12, gap: 3, padding: 0 },
                                visible: true,
                                onSubmit: 'act_reqsubmit',
                                children: [
                                    { id: 'cmp_reqname', type: 'input_text', props: { name: 'name', label: 'Your name', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                    { id: 'cmp_reqmail', type: 'input_text', props: { name: 'email', label: 'Email', required: true, inputType: 'email' }, style: { span: 6 }, visible: true },
                                    {
                                        id: 'cmp_reqkind',
                                        type: 'input_select',
                                        props: {
                                            name: 'category',
                                            label: 'Category',
                                            required: true,
                                            options: [
                                                { value: 'question', label: 'Question' },
                                                { value: 'change', label: 'Change request' },
                                                { value: 'issue', label: 'Report an issue' },
                                            ],
                                        },
                                        style: { span: 6 },
                                        visible: true,
                                    },
                                    { id: 'cmp_reqwhen', type: 'input_date', props: { name: 'needed_by', label: 'Needed by', required: false, defaultValue: null }, style: { span: 6 }, visible: true },
                                    { id: 'cmp_reqmsg', type: 'input_textarea', props: { name: 'details', label: 'Details', required: true, rows: 5 }, style: { span: 12 }, visible: true },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_reqdone',
                name: 'Thanks',
                icon: 'CheckCircle2',
                showInNav: false,
                maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_reqdone',
                        style: { padding: 6, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_reqok', type: 'callout', props: { title: 'Request received', text: 'Thanks — the team has your request and will follow up by email.', tone: 'success' }, style: { span: 12 }, visible: true },
                            { id: 'cmp_reqagain', type: 'button', props: { label: 'Submit another', variant: 'secondary', role: 'button' }, style: { span: 4 }, visible: true, onClick: 'act_reqagain' },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_reqsubmit: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: {},
                onSuccess: { toast: { message: 'Request sent.', tone: 'success' }, navigateTo: 'scr_reqdone' },
                onError: { toast: { message: 'Could not send your request — please try again.', tone: 'danger' } },
            },
            act_reqagain: { kind: 'navigate', screenId: 'scr_reqhome' },
        },
    },
};
