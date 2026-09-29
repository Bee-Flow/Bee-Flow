#!/usr/bin/env node
/**
 * Dutch for security keys (2026-09-26): a YubiKey or another FIDO2 key as a
 * second factor, on its own or next to an authenticator app. Covers the card
 * in Settings → Security, the forced 2FA setup, the "use your security key"
 * option in the sign-in step, and the refusals all three can show.
 *
 * Idempotent: only fills keys that are missing, so a workspace that curated
 * its own wording keeps it. ADD, NEVER RENAME. Auto-runs from server boot
 * (boot/bootMigrations.js). Manual usage:
 *   node server/migrations/add-nl-security-key-translations.js
 */

const NL_TRANSLATIONS = {
    'mfa.security_keys_title': 'Beveiligingssleutels',
    'mfa.security_keys_desc': 'Log in met één aanraking van een YubiKey of een andere FIDO2-beveiligingssleutel, in plaats van of naast een authenticator-app.',
    'mfa.security_keys_none': 'Nog geen beveiligingssleutels.',
    'mfa.security_key_add': 'Beveiligingssleutel toevoegen',
    'mfa.security_key_name_label': 'Naam',
    'mfa.security_key_name_placeholder': 'bijv. YubiKey 5C NFC',
    'mfa.security_key_code_label': 'Code uit je authenticator-app, of een herstelcode',
    'mfa.security_key_continue': 'Doorgaan',
    'mfa.security_key_touch': 'Steek je beveiligingssleutel in en raak hem aan zodra hij knippert.',
    'mfa.security_key_added_on': 'Toegevoegd op {date}',
    'mfa.security_key_last_used': 'Laatst gebruikt op {date}',
    'mfa.security_key_never_used': 'Nog niet gebruikt',
    'mfa.security_key_other_host': 'Geregistreerd op {host}; werkt niet op dit adres.',
    'mfa.security_key_rename': 'Naam wijzigen',
    'mfa.security_key_save': 'Opslaan',
    'mfa.security_key_remove': 'Verwijderen',
    'mfa.security_key_remove_confirm': 'Deze sleutel verwijderen? Je kunt nog steeds inloggen met je andere tweede factoren.',
    'mfa.security_key_unsupported': 'Deze browser kan hier geen beveiligingssleutels gebruiken. Gebruik een recente Chrome, Edge, Firefox of Safari op het HTTPS-adres van Bee Flow.',
    'mfa.security_key_cancelled': 'Het venster voor de beveiligingssleutel is gesloten of verlopen. Probeer het opnieuw.',
    'mfa.security_key_already_registered': 'Deze beveiligingssleutel is al geregistreerd.',
    'mfa.security_key_unavailable': 'Beveiligingssleutels werken niet vanaf dit adres. Open Bee Flow op zijn eigen HTTPS-adres en probeer het opnieuw.',
    'mfa.security_key_too_many': 'Je hebt het maximale aantal beveiligingssleutels bereikt. Verwijder er eerst een.',
    'mfa.security_key_expired': 'Dat duurde te lang. Probeer het opnieuw.',
    'mfa.security_key_rejected': 'De beveiligingssleutel kon niet worden geverifieerd. Probeer het opnieuw.',
    'mfa.security_key_none_here': 'Geen van je beveiligingssleutels is geregistreerd voor dit adres.',
    'mfa.attempts_exhausted': 'Te veel mislukte pogingen. Log opnieuw in met je wachtwoord.',
    'mfa.disable_removes_keys': 'Als je tweestapsverificatie uitzet, worden ook je beveiligingssleutels verwijderd.',
    'mfa.use_security_key': 'Beveiligingssleutel gebruiken',
    'mfa.use_security_key_instead': 'Gebruik liever je beveiligingssleutel',
    'mfa.use_security_key_setup': 'Gebruik liever een beveiligingssleutel',
    'mfa.use_authenticator_setup': 'Gebruik liever een authenticator-app',
    'mfa.security_key_enrol_intro': 'Steek je YubiKey of andere beveiligingssleutel in, geef hem een naam en raak hem aan zodra hij knippert.',
    'mfa.security_key_first_hint': 'Deze sleutel zet tweestapsverificatie aan. Je krijgt herstelcodes om goed te bewaren.',
    'mfa.security_key_prove_with_key': 'Raak eerst een sleutel aan die je al hebt geregistreerd, daarna de nieuwe.',
    'mfa.security_key_prove_with_code': 'Bevestig liever met een code',
    'mfa.security_key_prove_with_key_instead': 'Bevestig liever met een sleutel die je al hebt',
    'mfa.security_key_last_factor': 'Deze sleutel is je enige tweede factor. Voeg eerst een andere toe, of zet tweestapsverificatie uit.',
    'mfa.security_key_not_here': 'Je beveiligingssleutel werkt niet in deze browser. Gebruik een herstelcode, of log in vanuit een browser die beveiligingssleutels ondersteunt.',
    'mfa.proof_required': 'Bevestig eerst dat jij het bent, met een code uit je authenticator-app, een herstelcode of een van je beveiligingssleutels.',
    'mfa.sign_in_again': 'Er is iets veranderd aan dit account. Log opnieuw in met je wachtwoord.',
    'mfa.add_authenticator': 'Authenticator-app toevoegen',
    'mfa.enable_confirm_with_key': 'Raak na Inschakelen een van je beveiligingssleutels aan om te bevestigen dat jij het bent.',
    'mfa.confirm_with_recovery_or_key': 'Voer een herstelcode in, of bevestig met je beveiligingssleutel',
    'mfa.confirm_with_key': 'Bevestigen met beveiligingssleutel',
};

async function up() {
    const languageStore = require('../stores/languageStore');
    // Atomic across replicas (advisory lock in mutateConfig); existing values
    // win, only missing keys are added.
    const { added } = await languageStore.addMissingGUITranslations('nl', NL_TRANSLATIONS);
    if (added > 0) {
        console.log(`[Migration] add-nl-security-key-translations: added ${added} NL keys`);
    }
    return { added };
}

module.exports = { up, NL_TRANSLATIONS };

if (require.main === module) {
    up().then(({ added }) => {
        console.log(`Done (${added} added).`);
        process.exit(0);
    }).catch((e) => {
        console.error('Migration failed:', e);
        process.exit(1);
    });
}
