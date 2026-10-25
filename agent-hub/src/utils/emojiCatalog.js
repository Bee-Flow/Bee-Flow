/**
 * Frontend copy of server/core/cms/emojiCatalog.js. Pure data — no React.
 * The data is GENERATED into emojiCatalog.generated.mjs by `npm run gen:shared`;
 * change the server file and regenerate (emojiCatalog.lockstep.test.ts holds
 * the copy to its source).
 *
 * Consumers:
 *   - components/AppEmoji.jsx       (default emoji lookup by id)
 *   - admin/AppearanceAdminPanel    (renders categories when offline / fast init)
 *   - utils/helpers.js              (toolNameToCatalogId mapping)
 *
 * The Appearance panel still fetches the authoritative version from
 * /api/icons/catalog at runtime; this file is the synchronous fallback so
 * <AppEmoji id="..."> renders the right default before the catalog loads.
 */

import { EMOJI_BY_ID } from './emojiCatalog.generated.mjs';

export { EMOJI_CATEGORIES,   } from './emojiCatalog.generated.mjs';

export function defaultEmojiFor(id) {
    return EMOJI_BY_ID[id]?.defaultEmoji || null;
}

export function labelFor(id) {
    return EMOJI_BY_ID[id]?.label || id;
}
