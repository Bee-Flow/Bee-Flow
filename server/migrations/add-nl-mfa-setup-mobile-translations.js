#!/usr/bin/env node
/**
 * Dutch for the forced 2FA setup screen on a phone (BFSF-280): the one-line
 * explanation of what two-factor authentication is, the tap-to-add link that
 * opens the authenticator app on the same device, and the reworded
 * `mfa.required_desc`.
 *
 * That last one said "Your administrator requires ...", which is false for a
 * self-signup: the platform duty is on by default, so a founder with no
 * administrator lands on the same screen. The English now says the duty
 * applies to password accounts; the Dutch follows.
 *
 * Idempotent: new keys are only filled when missing, and the reworded key is
 * replaced only while it still holds the text an earlier catalogue seeded
 * (add-nl-signup-mfa-reset-auth-translations). A workspace that wrote its own
 * wording keeps it. Auto-runs from server boot (boot/bootMigrations.js).
 * Manual usage:
 *   node server/migrations/add-nl-mfa-setup-mobile-translations.js
 */

const NL_TRANSLATIONS = {
    'mfa.setup_intro': 'Tweefactorauthenticatie (2FA) voegt een tweede stap toe aan het inloggen: naast je wachtwoord voer je een code in uit een app op je telefoon, zodat een gestolen wachtwoord alleen je account niet opent.',
    'mfa.add_to_app_on_device': 'Toevoegen aan de authenticator-app op dit apparaat',
};

/** Keys whose English meaning changed: `was` is the seeded Dutch, `now` replaces it. */
const NL_REWORDED = {
    'mfa.required_desc': {
        was: 'Je beheerder vereist tweefactorauthenticatie voor wachtwoordaccounts. Stel het nu in om door te gaan.',
        now: 'Tweefactorauthenticatie is verplicht voor accounts die met een wachtwoord inloggen. Stel het nu in om door te gaan.',
    },
};

/**
 * The mutation itself, on a copy of the 'nl' blob. Pure, so the store's
 * mutator may run it more than once.
 */
function applyNl(merged) {
    let added = 0;
    let reworded = 0;
    for (const [key, value] of Object.entries(NL_TRANSLATIONS)) {
        if (!merged[key]) {
            merged[key] = value;
            added++;
        }
    }
    for (const [key, { was, now }] of Object.entries(NL_REWORDED)) {
        if (!merged[key] || merged[key] === was) {
            merged[key] = now;
            reworded++;
        }
    }
    return { merged, added, reworded };
}

async function up() {
    const languageStore = require('../stores/languageStore');
    // One atomic edit (advisory lock across replicas): add and reword together.
    let counts = { added: 0, reworded: 0 };
    await languageStore.mutateGUITranslations('nl', (current) => {
        const { merged, added, reworded } = applyNl(current);
        counts = { added, reworded };
        return merged;
    });
    if (counts.added > 0 || counts.reworded > 0) {
        console.log(`[Migration] add-nl-mfa-setup-mobile-translations applied (+${counts.added} keys, ${counts.reworded} reworded)`);
    }
    return counts;
}

module.exports = { up, applyNl, NL_TRANSLATIONS, NL_REWORDED };

if (require.main === module) {
    up().then(() => process.exit(0)).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
