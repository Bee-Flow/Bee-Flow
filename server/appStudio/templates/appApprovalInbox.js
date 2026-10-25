// @typecheck noImplicitAny
/**
 * App Studio template — Approval inbox (lite) — pending list + decision form. Honest v1
 * shape of approvals without table row-actions (first v1.1 item).
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-approval-inbox',
    version: 1,
    title: 'Approval inbox',
    description: 'A pending-items list fed by one Automation and a decision form that submits approve/reject to another.',
    category: 'Data',
    icon: 'CheckSquare',
    tags: ['approvals', 'workflow', 'review'],
    definition: {
        schemaVersion: 1,
        meta: { name: 'Approval inbox', description: 'Review and decide on pending items.', icon: 'CheckSquare' },
        theme: { primary: '#1D4ED8', ...THEME_DEFAULTS },
        homeScreenId: 'scr_apprhome',
        screens: [
            {
                id: 'scr_apprhome',
                name: 'Inbox',
                icon: 'Inbox',
                showInNav: true,
                maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_apprlist',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_apprtitle', type: 'heading', props: { text: 'Pending approvals', level: 1 }, style: { span: 9 }, visible: true },
                            { id: 'cmp_apprload', type: 'button', props: { label: 'Load pending', variant: 'ghost', iconLeft: 'RefreshCw', role: 'button' }, style: { span: 3, align: 'end' }, visible: true, onClick: 'act_apprload' },
                            {
                                id: 'cmp_apprlist',
                                type: 'list',
                                props: {
                                    source: { kind: 'actionResult', actionId: 'act_apprload', path: 'items' },
                                    titleKey: 'title',
                                    subtitleKey: 'requester',
                                    icon: 'FileText',
                                    emptyText: 'Nothing waiting for you. Load pending to check again.',
                                },
                                style: { span: 12 },
                                visible: true,
                            },
                        ],
                    },
                    {
                        id: 'sec_apprdecide',
                        style: { padding: 4, gap: 3, background: 'surface' },
                        children: [
                            { id: 'cmp_apprdhead', type: 'heading', props: { text: 'Make a decision', level: 3 }, style: { span: 12 }, visible: true },
                            {
                                id: 'cmp_apprfrm',
                                type: 'form',
                                props: { name: 'decision', submitLabel: 'Submit decision', showReset: true },
                                style: { span: 12, gap: 3, padding: 0 },
                                visible: true,
                                onSubmit: 'act_apprdecide',
                                children: [
                                    { id: 'cmp_apprid', type: 'input_text', props: { name: 'item_id', label: 'Item ID', placeholder: 'Copy it from the list above', required: true, inputType: 'text' }, style: { span: 6 }, visible: true },
                                    {
                                        id: 'cmp_apprverdict',
                                        type: 'input_select',
                                        props: {
                                            name: 'decision',
                                            label: 'Decision',
                                            required: true,
                                            options: [
                                                { value: 'approve', label: 'Approve' },
                                                { value: 'reject', label: 'Reject' },
                                            ],
                                        },
                                        style: { span: 6 },
                                        visible: true,
                                    },
                                    { id: 'cmp_apprnote', type: 'input_textarea', props: { name: 'note', label: 'Note (optional)', required: false, rows: 3 }, style: { span: 12 }, visible: true },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_apprload: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: {},
                onError: { toast: { message: 'Could not load pending items.', tone: 'danger' } },
            },
            act_apprdecide: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: {},
                onSuccess: { toast: { message: 'Decision recorded.', tone: 'success' } },
                onError: { toast: { message: 'Could not record the decision.', tone: 'danger' } },
            },
        },
    },
};
