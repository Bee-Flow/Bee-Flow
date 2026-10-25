// @typecheck noImplicitAny
/**
 * App Studio template — Event planner — a calendar over your own events + an add-event
 * form (create_record sequence).
 *
 * Entry of the gallery in ../templates.js, which documents the template
 * shape and the order the gallery lists them in.
 */

'use strict';

const { THEME_DEFAULTS } = require('./themeDefaults');

module.exports = {
    id: 'app-event-planner',
    version: 1,
    title: 'Event planner',
    description: 'Plan team events on a month calendar and add new ones with a simple form. Events live in your own data table, coloured by category.',
    category: 'Data',
    icon: 'CalendarDays',
    tags: ['events', 'calendar', 'planning'],
    dataModel: {
        modelVersion: 1,
        tables: [
            {
                id: 'tbl_evevt', key: 'events', name: 'Events', icon: 'Calendar',
                fields: [
                    { id: 'fld_evtitle', key: 'title', name: 'Title', type: 'text', required: true },
                    { id: 'fld_evdate', key: 'date', name: 'Date', type: 'date', required: true },
                    { id: 'fld_evend', key: 'end_date', name: 'End date', type: 'date' },
                    { id: 'fld_evloc', key: 'location', name: 'Location', type: 'text' },
                    {
                        id: 'fld_evcat', key: 'category', name: 'Category', type: 'select',
                        options: [
                            { value: 'meeting', label: 'Meeting' },
                            { value: 'deadline', label: 'Deadline' },
                            { value: 'social', label: 'Social' },
                        ],
                    },
                ],
                access: { default: 'app' },
            },
        ],
        roles: [],
        roleMapping: { default: 'app', byGroup: {} },
    },
    seed: {
        tbl_evevt: [
            { title: 'Team standup', date: '2026-07-20', location: 'Room A', category: 'meeting' },
            { title: 'Project deadline', date: '2026-07-25', location: '', category: 'deadline' },
            { title: 'Summer social', date: '2026-07-31', end_date: '2026-07-31', location: 'Rooftop', category: 'social' },
            { title: 'Board review', date: '2026-08-03', location: 'HQ', category: 'meeting' },
        ],
    },
    definition: {
        schemaVersion: 2,
        meta: { name: 'Event planner', description: 'Plan and schedule team events.', icon: 'CalendarDays' },
        theme: { primary: '#B45309', ...THEME_DEFAULTS },
        homeScreenId: 'scr_evcal',
        roles: [],
        screens: [
            {
                id: 'scr_evcal', name: 'Calendar', icon: 'CalendarDays', showInNav: true, maxWidth: 'wide',
                sections: [
                    {
                        id: 'sec_evcal', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_evh1', type: 'heading', props: { text: 'Event calendar', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_evcal', type: 'calendar',
                                props: {
                                    source: { kind: 'records', tableId: 'tbl_evevt' },
                                    dateKey: 'date',
                                    endDateKey: 'end_date',
                                    titleKey: 'title',
                                    colorKey: 'category',
                                    view: 'month',
                                },
                                style: { span: 12 },
                            },
                        ],
                    },
                ],
            },
            {
                id: 'scr_evnew', name: 'Add event', icon: 'Plus', showInNav: true, maxWidth: 'narrow',
                sections: [
                    {
                        id: 'sec_evnew', style: { padding: 4, gap: 3, background: 'none' },
                        children: [
                            { id: 'cmp_evh2', type: 'heading', props: { text: 'Add an event', level: 1 }, style: { span: 12 } },
                            {
                                id: 'cmp_evform', type: 'form',
                                props: { name: 'event', submitLabel: 'Add event', showReset: false },
                                style: { span: 12, gap: 3, padding: 0 },
                                onSubmit: 'act_evsubmit',
                                children: [
                                    { id: 'cmp_evtitle', type: 'input_text', props: { name: 'title', label: 'Title', required: true }, style: { span: 12 } },
                                    { id: 'cmp_evdate', type: 'input_date', props: { name: 'date', label: 'Date', required: true }, style: { span: 6 } },
                                    { id: 'cmp_evloc', type: 'input_text', props: { name: 'location', label: 'Location' }, style: { span: 6 } },
                                    {
                                        id: 'cmp_evcat', type: 'input_select',
                                        props: {
                                            name: 'category', label: 'Category',
                                            options: [
                                                { value: 'meeting', label: 'Meeting' },
                                                { value: 'deadline', label: 'Deadline' },
                                                { value: 'social', label: 'Social' },
                                            ],
                                        },
                                        style: { span: 6 },
                                    },
                                ],
                            },
                        ],
                    },
                ],
            },
        ],
        actions: {
            act_evsubmit: {
                kind: 'sequence',
                steps: [
                    {
                        kind: 'create_record', tableId: 'tbl_evevt',
                        values: {
                            title: { kind: 'formula', expr: 'form.title' },
                            date: { kind: 'formula', expr: 'form.date' },
                            location: { kind: 'formula', expr: 'form.location' },
                            category: { kind: 'formula', expr: 'form.category' },
                        },
                    },
                    { kind: 'toast', message: 'Event added.', tone: 'success' },
                    { kind: 'navigate', screenId: 'scr_evcal' },
                ],
            },
        },
    },
};
