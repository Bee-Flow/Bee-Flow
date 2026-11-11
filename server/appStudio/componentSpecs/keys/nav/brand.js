'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: '{ name? ≤60, logo?: https URL | asset:<id>, showName?: boolean }',
    description: 'The name and logo in the app\'s top bar or sidebar. '
        + 'Use it when they differ from meta.name and design.logoUrl. '
        + 'logo is an https URL or asset:<id> of an uploaded image (app_list_assets); showName false shows the logo alone. '
        + 'Set it with app_set_shell { brand: { name: "Field desk", logo: "asset:<id>" } }; null removes it.',
};
