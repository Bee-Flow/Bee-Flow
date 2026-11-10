#!/usr/bin/env node
// @typecheck strict
/**
 * Dutch for the corrected action limits in the App actions lesson quiz (Nov 2026).
 * The English question now says 120 steps per sequence, eight levels of nesting and
 * 200 actions per app (the real ceilings in appStudio/componentSpecs/limits.js);
 * the Dutch said 60, six and 60.
 *
 * NL_REWORDED: replaced only while a workspace still has the OLD shipped Dutch
 * (`was`), so an admin's own wording stays. Idempotent. Auto-runs from server
 * boot (boot/bootMigrations.js). Manual:
 *   node server/migrations/update-nl-learn-action-limits-2026-11.js
 */

/** @type {Readonly<Record<string, { was: string[], now: string }>>} */
const NL_REWORDED = Object.freeze({
    'learn.apps-actions-and-automations.q-caps.choice.a.label': {
        was: ['De vijf stappen binnen het Voor elk tellen mee voor de 60 stappen die in die ene reeks zijn toegestaan, nesten mag zes niveaus diep gaan, en een Voor elk loopt hooguit 200 keer.'],
        now: 'De vijf stappen binnen het Voor elk tellen mee voor de 120 stappen die in die ene reeks zijn toegestaan, nesten mag acht niveaus diep gaan, en een Voor elk loopt hooguit 200 keer.',
    },
    'learn.apps-actions-and-automations.q-caps.choice.b.label': {
        was: ['Alleen stappen op het hoogste niveau tellen mee voor de 60; stappen binnen een Voor elk of een Als… zijn gratis.'],
        now: 'Alleen stappen op het hoogste niveau tellen mee voor de 120; stappen binnen een Voor elk of een Als… zijn gratis.',
    },
    'learn.apps-actions-and-automations.q-caps.choice.c.label': {
        was: ['Zestig is de bovengrens voor alle acties in de app bij elkaar, dus een lange flow laat geen ruimte voor andere knoppen.'],
        now: 'Tweehonderd is de bovengrens voor alle acties in de app bij elkaar, dus een lange flow laat geen ruimte voor andere knoppen.',
    },
    'learn.apps-actions-and-automations.q-caps.choice.c.feedback': {
        was: ['Twee aparte bovengrenzen die toevallig hetzelfde getal delen: 60 acties per app, en 60 stappen binnen één reeks.'],
        now: 'Twee aparte bovengrenzen die toevallig in grootte verschillen: 200 acties per app, en 120 stappen binnen één reeks.',
    },
    'learn.apps-actions-and-automations.q-caps.explanation': {
        was: ['Een bediening die meer dan 60 stappen of meer dan zes niveaus nesten nodig heeft, zegt je dat de logica in een automatisering hoort. Koppel de knop dan aan die automatisering.'],
        now: 'Een bediening die meer dan 120 stappen of meer dan acht niveaus nesten nodig heeft, zegt je dat de logica in een automatisering hoort. Koppel de knop dan aan die automatisering.',
    },
});

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's mutator may run it more than once.
 * @param {Record<string, string>} merged
 */
function applyNl(merged) {
    let reworded = 0;
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        if (!merged[key] || was.includes(merged[key])) {
            if (merged[key] !== now) reworded++;
            merged[key] = now;
        }
    }
    return { merged, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    let reworded = 0;
    await languageStore.mutateGUITranslations('nl', (/** @type {Record<string, string>} */ current) => {
        const result = applyNl(current);
        reworded = result.reworded;
        return result.merged;
    });
    if (reworded > 0) {
        console.log(`[Migration] update-nl-learn-action-limits-2026-11 applied (${reworded} reworded)`);
    }
    return { reworded };
}

module.exports = { up, applyNl, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
