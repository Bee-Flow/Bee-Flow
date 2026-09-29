/**
 * De bron-grammatica van een modeltabel staat op DRIE plekken, en dit bestand
 * houdt ze aan elkaar.
 *
 *   1. core/dataEngine/dataModel/vocabulary.js — DE bron
 *   2. server-zijdig — appStudio/validate/refs.js, appStudio/dataModel/
 *      modelValidate.js en appStudio/datatableSource.js importeren (1) en zijn
 *      dus per definitie in de pas
 *   3. agent-hub/.../tables/TablesManager.jsx — een LETTERLIJKE kopie, want er
 *      is geen gedeelde vocabulairemodule tussen server en client
 *
 * Kopie 3 kan niet importeren, dus wordt hij hier GELEZEN. Zonder deze test is
 * de drift stil: voeg morgen een derde mode toe en de validator accepteert hem
 * terwijl het scherm hem "Unknown access" noemt en de rechtenlaag de hele tabel
 * met 422 weigert — een fout die pas bovenkomt als een gebruiker de app opent.
 * De richting is veilig (versmallen), maar veilig-en-stil is precies het soort
 * fout dat een jaar blijft liggen.
 *
 * Zelfde patroon als server/automation/notificationDefaults.test.js, dat om
 * dezelfde reden een agent-hub-bestand inleest.
 *
 * Draai: cd server && node --test --test-reporter=tap core/dataEngine/dataModel/vocabulary.lockstep.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
} = require('./vocabulary');

const TABLES_MANAGER = path.resolve(
    __dirname, '../../../../agent-hub/src/components/admin/Studio/AppStudio/tables/TablesManager.jsx',
);

/** De letterlijke `const NAME = ['a', 'b'];` uit een JSX-bestand. */
function arrayLiteral(source, name) {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
    assert.ok(m, `${name} niet gevonden in TablesManager.jsx — is hij hernoemd?`);
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('TablesManager kent exact dezelfde modes als het vocabulaire', () => {
    // Genuinely textual, zoals de bestandskop al zegt: een .jsx-bestand in
    // agent-hub kan hier niet ge-require't worden (geen JSX-transform, geen
    // DOM), en dat is precies waarom kopie 3 een letterlijke kopie is in
    // plaats van een import — er is niets om aan te roepen.
    const src = fs.readFileSync(TABLES_MANAGER, 'utf8');
    assert.deepEqual(arrayLiteral(src, 'TABLE_SOURCE_MODES'), [...TABLE_SOURCE_MODES]);
});

test('TablesManager noemt dezelfde ENE schrijfbare mode en dezelfde kind', () => {
    const src = fs.readFileSync(TABLES_MANAGER, 'utf8');
    // `sourceIsWritable` is de plek waar het scherm beslist of het de knop
    // "rijen bewerken" laat zien. Hij moet dezelfde twee woorden noemen als
    // vocabulary.js, anders belooft het scherm iets wat de server weigert.
    const m = /function sourceIsWritable\(source\) \{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, 'sourceIsWritable niet gevonden in TablesManager.jsx');
    const body = m[1];
    assert.match(body, new RegExp(`source\\.mode === '${WRITABLE_TABLE_SOURCE_MODE}'`));
    for (const kind of TABLE_SOURCE_KINDS) {
        assert.match(body, new RegExp(`source\\.kind === '${kind}'`),
            `sourceIsWritable kent kind '${kind}' niet`);
    }
    // Precies één kind-vergelijking: een tweede kind in het vocabulaire moet
    // hier een keuze afdwingen, niet stilzwijgend als niet-schrijfbaar gelden.
    assert.equal((body.match(/source\.kind ===/g) || []).length, TABLE_SOURCE_KINDS.length);
});

test('het vocabulaire zelf blijft de kleinst mogelijke lijst', () => {
    // Niet cosmetisch: elke waarde hier is een recht dat ergens wordt
    // afgedwongen, en `WRITABLE_TABLE_SOURCE_MODE` moet er een van zijn.
    assert.ok(TABLE_SOURCE_MODES.includes(WRITABLE_TABLE_SOURCE_MODE));
    assert.equal(TABLE_SOURCE_MODES.filter((m) => m !== WRITABLE_TABLE_SOURCE_MODE).length,
        TABLE_SOURCE_MODES.length - 1, 'er is precies ÉÉN schrijfbare mode');
});
