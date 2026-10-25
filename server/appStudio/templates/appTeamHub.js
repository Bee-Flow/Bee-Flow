// @typecheck strict
/**
 * App Studio template — Team hub — pure content + contact form; zero automation deps, so it
 * works instantly on install and shows off theming/multi-screen nav.
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-team-hub',
    version: 1,
    title: 'Team hub',
    description: 'A small internal site: welcome page, useful links, and a contact form. Works out of the box — no automation required.',
    category: 'Content',
    icon: 'Users',
    tags: ['intranet', 'content', 'links'],
    definition: {
        schemaVersion: 1,
        meta: { name: 'Team hub', description: 'Everything the team needs in one place.', icon: 'Users' },
        theme: { primary: '#B45309', ...THEME_DEFAULTS, radius: 'sm' },
        // Identity: the "paper" editorial look — warm amber, Cabinet
        // Grotesk, hairline surfaces — an intranet that reads like a
        // well-set document instead of an admin console.
        design: { preset: 'paper', font: 'cabinet', surface: 'hairline', motion: 'subtle', chartPalette: 'classic', logoUrl: null },
        homeScreenId: 'scr_hubhome',
        screens: [
            {
                id: 'scr_hubhome',
                name: 'Welcome',
                icon: 'Home',
                showInNav: true,
                maxWidth: 'medium',
                sections: [
                    {
                        id: 'sec_hubhero',
                        style: { padding: 5, gap: 2, background: 'gradient' },
                        children: [
                            { id: 'cmp_hubtitle', type: 'heading', props: { text: 'Welcome to the team hub', level: 1 }, style: { span: 12, align: 'center' }, visible: true },
                            { id: 'cmp_hublead', type: 'text', props: { text: 'Quick links, announcements and a direct line to the team.', muted: true }, style: { span: 12, align: 'center' }, visible: true },
                        ],
                    },
                    {
                        id: 'sec_hubcards',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            {
                                id: 'cmp_hubcard1',
                                type: 'card',
                                props: { title: 'Getting started', description: 'New here? Start with these.' },
                                style: { span: 6, padding: 3, gap: 2, background: 'surface' },
                                visible: true,
                                children: [
                                    { id: 'cmp_hubc1txt', type: 'text', props: { text: 'Read the onboarding guide, join the team channel, and book your intro call.', muted: false }, style: { span: 12 }, visible: true },
                                    { id: 'cmp_hubc1btn', type: 'button', props: { label: 'Open the guide', variant: 'secondary', iconLeft: 'BookOpen', role: 'button' }, style: { span: 6 }, visible: true, onClick: 'act_hubguide' },
                                ],
                            },
                            {
                                id: 'cmp_hubcard2',
                                type: 'card',
                                props: { title: 'This week', description: 'What is happening.' },
                                style: { span: 6, padding: 3, gap: 2, background: 'surface' },
                                visible: true,
                                children: [
                                    { id: 'cmp_hubc2note', type: 'callout', props: { title: null, text: 'Sprint review Friday 15:00 — demo your work!', tone: 'info' }, style: { span: 12 }, visible: true },
                                ],
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_hubcontact',
                name: 'Contact',
                icon: 'Mail',
                showInNav: true,
                maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_hubform',
                        style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_hubchead', type: 'heading', props: { text: 'Contact the team', level: 2, accent: 'bar' }, style: { span: 12 }, visible: true },
                            {
                                id: 'cmp_hubcfrm',
                                type: 'form',
                                props: { name: 'contact', submitLabel: 'Send message', showReset: false },
                                style: { span: 12, gap: 3, padding: 0 },
                                visible: true,
                                onSubmit: 'act_hubcontact',
                                children: [
                                    { id: 'cmp_hubcname', type: 'input_text', props: { name: 'name', label: 'Your name', required: true, inputType: 'text' }, style: { span: 12 }, visible: true },
                                    { id: 'cmp_hubcmsg', type: 'input_textarea', props: { name: 'message', label: 'Message', required: true, rows: 4 }, style: { span: 12 }, visible: true },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_hubguide: { kind: 'open_url', url: 'https://example.com/onboarding', newTab: true },
            act_hubcontact: {
                kind: 'run_automation',
                automationId: null,
                inputMapping: {},
                onSuccess: { toast: { message: 'Message sent — thanks!', tone: 'success' } },
                onError: { toast: { message: 'Could not send your message.', tone: 'danger' } },
            },
        },
    },
};
