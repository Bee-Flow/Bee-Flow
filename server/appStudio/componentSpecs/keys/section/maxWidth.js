'use strict';
// @typecheck strict

module.exports = {
    since: 3,
    shape: 'inherit|narrow|medium|wide|full',
    description: 'Caps the width of one section and centres it in the screen. '
        + 'narrow 640px, medium 960px, wide 1280px; full and inherit take the screen\'s own width, and inherit (the default) is stored as no key at all. '
        + 'A section is never wider than its screen, so for a full-bleed band set the screen maxWidth to full and give the other sections medium or narrow. '
        + 'Set it with app_update_section {sectionId, maxWidth: "narrow"}.',
};
