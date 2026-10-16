// @typecheck
'use strict';

const { safeIconAsset } = require('../stores/cms/localeMedia');

const NAV_ICON_HINT = 'A mega item icon is a Lucide PascalCase name (e.g. ShieldCheck), an uploaded asset (cms/<file> or /api/cms/asset/cms/<file>, see cms_list_assets) or, for old content only, an emoji.';

/**
 * A mega item's icon. An address-shaped value (starts with "cms/" or "/") must be
 * an uploaded-asset path; anything else is a Lucide name or legacy text.
 * @param {string} value
 * @param {string} path
 * @returns {{ icon: string } | { error: string, _fixHint: string }}
 */
function sanitizeNavIcon(value, path) {
    const raw = value.trim();
    if (raw.startsWith('cms/') || raw.startsWith('/')) {
        const asset = safeIconAsset(raw);
        if (!asset) {
            return { error: `${path}.icon ${JSON.stringify(raw)} is not an uploaded asset of this site.`, _fixHint: NAV_ICON_HINT };
        }
        return { icon: asset };
    }
    return { icon: value };
}

module.exports = { sanitizeNavIcon, NAV_ICON_HINT };
