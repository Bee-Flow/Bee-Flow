// @typecheck strict
'use strict';

const { NAV_STYLES } = require('../../appDesignSpec');

const ITEM_SCHEMA = {
    type: 'object',
    properties: {
        label: { type: 'string', description: 'What the link says (≤40 characters).' },
        icon: { type: ['string', 'null'], description: 'A Lucide icon name, or null.' },
        screenId: { type: 'string', description: 'A screen of this app. Leave out for an address.' },
        url: { type: 'string', description: 'An http or https address, opened in a new tab. Leave out for a screen.' },
    },
    required: ['label'],
};

module.exports = {
    name: 'app_set_shell',
    since: 3,
    description: 'Set the app shell: the navigation style (style "none" draws no navigation at all), a hidden top bar (header), '
        + 'links of the app\'s own beside its screens (items), a footer line (footerText) and the brand name and logo (brand). '
        + 'Each key you pass replaces the stored one and null removes it; keys you leave out stay as they are. '
        + 'Read the entries nav.style, nav.header, nav.items, nav.footerText and nav.brand with app_inspect_catalog first. '
        + 'The answer echoes the nav as stored, with _hints for anything that was dropped.',
    schema: {
        type: 'object',
        properties: {
            style: { type: ['string', 'null'], enum: [...NAV_STYLES, null], description: 'The navigation style; null goes back to tabs.' },
            header: { type: ['string', 'null'], enum: ['bar', 'hidden', null], description: 'hidden: no top bar.' },
            items: { type: ['array', 'null'], items: ITEM_SCHEMA, maxItems: 10, description: 'The whole list of links; [] or null removes them.' },
            footerText: { type: ['string', 'null'], description: 'One line under every screen (≤120 characters).' },
            brand: {
                type: ['object', 'null'],
                properties: {
                    name: { type: 'string' },
                    logo: { type: ['string', 'null'], description: 'An https URL or asset:<id> of an uploaded image.' },
                    showName: { type: 'boolean' },
                },
                description: 'The name and logo of the shell, when they differ from meta.name and design.logoUrl.',
            },
        },
    },
    /**
     * @param {{ def: Record<string, unknown> }} draftWrap
     * @param {Record<string, unknown>} args
     */
    apply: (draftWrap, args) => require('../appSetShell.mts').apply(draftWrap, args),
    mutating: true,
    core: false,
    mcp: true,
    verb: { key: 'studio_apps_lk18.act_set_shell', en: 'Changed the app shell' },
};
