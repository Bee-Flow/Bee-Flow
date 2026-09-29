/**
 * Transactional Email Template Defaults
 *
 * Built-in English text for the admin-configurable lifecycle emails
 * (verification + welcome). These serve as the per-field fallback for any
 * locale — see languageStore.getEffectiveEmailTemplate().
 *
 * Each template is a flat object of structured fields rendered through the
 * shared branded shell (_renderEmailShell in utils/emailService.js):
 *   - subject  : email subject line (plain text)
 *   - title    : big heading in the email header
 *   - intro    : greeting line (e.g. "Hi Tom,")
 *   - body     : main paragraph(s)
 *   - ctaLabel : text on the call-to-action button
 *
 * Field values may contain {{variable}} placeholders (see
 * EMAIL_TEMPLATE_VARIABLES). The send functions HTML-escape the substituted
 * values, so admins author plain text here, not HTML.
 */

// Template identifiers (order = display order in the admin editor).
// The dsr_* trio are the GDPR Art. 12 letters to a data subject
// (acknowledgement with identity link, Art. 12(3) extension, result). Their
// subject lines carry no personal data — only the request number and type
// (BFSF-441): the address is the channel, the body is what the subject reads.
const EMAIL_TEMPLATE_IDS = ['verification', 'welcome', 'dsr_ack', 'dsr_extension', 'dsr_result'];

// The structured fields every template exposes.
const EMAIL_TEMPLATE_FIELDS = ['subject', 'title', 'intro', 'body', 'ctaLabel'];

// Letters that carry NO button, and never will: there is no URL to send the
// reader to. The extension notice and the result letter are read and closed —
// the subject acts by replying to the DPO address in the body, not by clicking.
// Their `ctaLabel` is therefore empty by design, which is why the "every field
// is filled" contract skips it for these two (utils/emailTemplates.test.js) and
// why the admin editor has nothing to offer here. The senders blank the label
// again at send time, so an override cannot resurrect a button without a URL.
const EMAIL_TEMPLATES_WITHOUT_CTA = Object.freeze(['dsr_extension', 'dsr_result']);

// Placeholder tokens available per template (for the admin UI hint chips and
// so AI-translation can be told to preserve them).
const EMAIL_TEMPLATE_VARIABLES = {
    verification: ['name', 'verifyUrl', 'orgName'],
    welcome: ['name', 'loginUrl', 'learnUrl', 'orgName'],
    dsr_ack: ['requestId', 'requestType', 'dueDate', 'orgName', 'dpoEmail', 'statusUrl'],
    dsr_extension: ['requestId', 'requestType', 'extendedUntil', 'reason', 'orgName', 'dpoEmail'],
    dsr_result: ['requestId', 'requestType', 'status', 'resultSummary', 'orgName', 'dpoEmail'],
};

// Human-readable labels for the editor.
const EMAIL_TEMPLATE_LABELS = {
    verification: 'Email verification',
    welcome: 'Welcome / confirmation',
    dsr_ack: 'Data-subject request — acknowledgement',
    dsr_extension: 'Data-subject request — deadline extension',
    dsr_result: 'Data-subject request — result',
};

// English defaults. The CTA URL is supplied at send time (verifyUrl /
// loginUrl), so ctaLabel is text-only and the URL is not part of the body.
const EMAIL_TEMPLATE_DEFAULTS = {
    verification: {
        subject: 'Confirm your email address',
        title: 'Confirm your email',
        intro: 'Hi {{name}},',
        body: 'Thanks for creating a BeeFlow account. Please confirm your email address to activate your account and get started. This link expires in 24 hours. If you didn\'t create an account, you can safely ignore this email.',
        ctaLabel: 'Confirm email address',
    },
    welcome: {
        subject: 'Welcome to BeeFlow',
        title: 'Welcome to BeeFlow 🎉',
        intro: 'Hi {{name}},',
        body: 'Your email address is confirmed and your account is ready. You can log in any time and start using the platform. New to Bee Flow? The Learning Center will get you up to speed fast — explore it here: {{learnUrl}}',
        ctaLabel: 'Log in',
    },
    dsr_ack: {
        subject: 'We received your request #{{requestId}}',
        title: 'Your request has been received',
        intro: 'Hello,',
        body: 'We have received your {{requestType}} request (#{{requestId}}) concerning the personal data {{orgName}} processes about you. Under GDPR Article 12(3) we will respond by {{dueDate}}.\n\nTo confirm that this request came from you, please use the button below. The link is valid for 7 days and can be used once.\n\nYou can check the status of your request at any time: {{statusUrl}}\n\nQuestions? Contact our data protection officer at {{dpoEmail}}.',
        ctaLabel: 'Confirm it was me',
    },
    dsr_extension: {
        subject: 'Your request #{{requestId}} — response period extended',
        title: 'We need a little more time',
        intro: 'Hello,',
        body: 'We are still working on your {{requestType}} request (#{{requestId}}). As GDPR Article 12(3) allows, {{orgName}} is extending the response period by two months; you will hear from us by {{extendedUntil}}.\n\nReason for the extension:\n{{reason}}\n\nQuestions? Contact our data protection officer at {{dpoEmail}}.',
        ctaLabel: '',
    },
    dsr_result: {
        subject: 'Your request #{{requestId}} has been handled',
        title: 'Your request has been handled',
        intro: 'Hello,',
        body: 'Your {{requestType}} request (#{{requestId}}) to {{orgName}} has been {{status}}.\n\n{{resultSummary}}\n\nIf you disagree with this outcome you may contact our data protection officer at {{dpoEmail}} or lodge a complaint with your supervisory authority.',
        ctaLabel: '',
    },
};

// Built-in translations. These are the per-field fallback for a locale BEFORE
// the admin's own override (languageStore.getEffectiveEmailTemplate merges
// override → locale default → English). Only the DSR letters ship in Dutch:
// the lifecycle mails were English-only before and stay that way here.
const EMAIL_TEMPLATE_LOCALE_DEFAULTS = {
    nl: {
        dsr_ack: {
            subject: 'We hebben uw verzoek #{{requestId}} ontvangen',
            title: 'Uw verzoek is ontvangen',
            intro: 'Beste,',
            body: 'We hebben uw verzoek tot {{requestType}} (#{{requestId}}) ontvangen over de persoonsgegevens die {{orgName}} over u verwerkt. Op grond van artikel 12(3) AVG reageren wij uiterlijk op {{dueDate}}.\n\nOm te bevestigen dat dit verzoek van u komt, gebruikt u de knop hieronder. De link is 7 dagen geldig en kan één keer worden gebruikt.\n\nU kunt de status van uw verzoek altijd bekijken: {{statusUrl}}\n\nVragen? Neem contact op met onze functionaris gegevensbescherming via {{dpoEmail}}.',
            ctaLabel: 'Bevestig dat ik dit was',
        },
        dsr_extension: {
            subject: 'Uw verzoek #{{requestId}} — reactietermijn verlengd',
            title: 'We hebben iets meer tijd nodig',
            intro: 'Beste,',
            body: 'We werken nog aan uw verzoek tot {{requestType}} (#{{requestId}}). Zoals artikel 12(3) AVG toestaat, verlengt {{orgName}} de reactietermijn met twee maanden; u hoort uiterlijk op {{extendedUntil}} van ons.\n\nReden van de verlenging:\n{{reason}}\n\nVragen? Neem contact op met onze functionaris gegevensbescherming via {{dpoEmail}}.',
            ctaLabel: '',
        },
        dsr_result: {
            subject: 'Uw verzoek #{{requestId}} is afgehandeld',
            title: 'Uw verzoek is afgehandeld',
            intro: 'Beste,',
            body: 'Uw verzoek tot {{requestType}} (#{{requestId}}) aan {{orgName}} is {{status}}.\n\n{{resultSummary}}\n\nBent u het niet eens met deze uitkomst? Neem dan contact op met onze functionaris gegevensbescherming via {{dpoEmail}} of dien een klacht in bij de toezichthouder.',
            ctaLabel: '',
        },
    },
};

/**
 * Get the built-in template for a given template ID. English by default; when
 * a `locale` is given and a built-in translation exists, its fields win per
 * field over the English copy. Returns a fresh shallow copy so callers can
 * mutate safely. Null if unknown.
 */
function getDefaultEmailTemplate(templateId, locale = null) {
    const tpl = EMAIL_TEMPLATE_DEFAULTS[templateId];
    if (!tpl) return null;
    const lang = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : null;
    const localised = (lang && EMAIL_TEMPLATE_LOCALE_DEFAULTS[lang]?.[templateId]) || null;
    return localised ? { ...tpl, ...localised } : { ...tpl };
}

module.exports = {
    EMAIL_TEMPLATE_IDS,
    EMAIL_TEMPLATE_FIELDS,
    EMAIL_TEMPLATES_WITHOUT_CTA,
    EMAIL_TEMPLATE_VARIABLES,
    EMAIL_TEMPLATE_LABELS,
    EMAIL_TEMPLATE_DEFAULTS,
    EMAIL_TEMPLATE_LOCALE_DEFAULTS,
    getDefaultEmailTemplate,
};
