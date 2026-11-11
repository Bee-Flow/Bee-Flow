// @typecheck strict
/**
 * The pictures a built-in template ships, as entries of its `assets` (portableAssets.mts:
 * { id, mime, sha256, size, data }), read from ./pictures/ when the template module loads.
 *
 * The files are original placeholder art drawn by server/scripts/gen-template-pictures.mjs. The
 * id is the name the template uses (`asset:<id>`, in its definition or in a sample row); on
 * install every file is decided again exactly like an upload and stored in the new app under an
 * id of its own (portableAssetStore.mts carryTemplateAssets).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {Array<{ id: string, file: string }>} pictures
 */
function templatePictures(pictures) {
    const { writePortableAssets } = require('../portableAssets.mts');
    const { sniffAssetMime } = require('../appAssets.mts');
    return writePortableAssets(pictures.map(({ id, file }) => {
        const bytes = fs.readFileSync(path.join(__dirname, 'pictures', file));
        const mime = sniffAssetMime(bytes);
        if (!mime) throw new Error(`templates/pictures/${file} is not a picture an app may hold`);
        return { id, mime, bytes };
    }));
}

module.exports = { templatePictures };
