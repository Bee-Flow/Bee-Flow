/**
 * The English line for each piece of AI Act evidence (aiActDetect.js). The
 * builder translates by `code` (routines.aiact.reason.<code>) and falls back
 * to this text; the params are what the sentence names. No dashes as
 * punctuation (owner rule), no addresses, no model prose.
 */

'use strict';

const AREA_TEXT = Object.freeze({
    biometrics: 'biometrics',
    critical_infrastructure: 'critical infrastructure',
    education: 'education',
    employment: 'work and hiring',
    essential_services: 'essential services and benefits',
    credit: 'credit',
    insurance: 'life and health insurance',
    law_enforcement: 'law enforcement',
    migration: 'migration and borders',
    justice: 'justice and elections',
});

const PRACTICE_TEXT = Object.freeze({
    subliminal_manipulation: 'manipulating people',
    exploiting_vulnerabilities: 'exploiting vulnerable people',
    social_scoring: 'social scoring',
    criminal_risk_profiling: 'predicting crime from profiles',
    facial_scraping: 'scraping faces for recognition',
    emotion_recognition_work_education: 'reading emotions at work or school',
    biometric_categorisation: 'sorting people by biometric data',
    realtime_biometric_id: 'live biometric identification in public',
});

const list = (ids, names) => (Array.isArray(ids) ? ids : []).map(id => names[id] || id).join(', ');
const quoted = (steps) => (Array.isArray(steps) ? steps : []).map(s => `"${s.label}"`).join(', ');

const TEXT = {
    'ai_act.uses_ai.steps': (p) => `Bee found ${p.count === 1 ? 'an AI step' : `${p.count} AI steps`}: ${quoted(p.steps)}.`,
    'ai_act.uses_ai.none': () => 'Bee found no AI steps.',
    'ai_act.uses_ai.block_unknown': (p) => `Bee could not look inside "${p.label}", a reusable step.`,
    'ai_act.external.none': () => 'The output stays inside your own organisation.',
    'ai_act.external.email': (p) => `"${p.label}" sends an e-mail that can reach people outside the organisation.`,
    'ai_act.external.email_fixed': (p) => `"${p.label}" e-mails a fixed address outside the organisation.`,
    'ai_act.external.share_by_email': (p) => `"${p.label}" shares a file by e-mail.`,
    'ai_act.external.signature_request': (p) => `"${p.label}" sends a document to be signed.`,
    'ai_act.external.social_post': (p) => `"${p.label}" publishes a post.`,
    'ai_act.external.webpage': (p) => `"${p.label}" changes a web page.`,
    'ai_act.external.calendar_invite': (p) => `"${p.label}" invites people to an event.`,
    'ai_act.external.http': (p) => `"${p.label}" sends data to another system.`,
    'ai_act.external.ai_flows': (p) => `AI output goes into "${p.label}".`,
    'ai_act.external.no_ai': (p) => `No AI output goes into "${p.label}".`,
    'ai_act.sensitive.hints': () => 'The name, description or prompts mention one of these areas. Check whether the automation helps decide about people there.',
    'ai_act.sensitive.none_found': () => 'Bee read the name, description and AI instructions and found no decisions about people in a high-risk area.',
    'ai_act.sensitive.found': (p) => `Bee thinks it helps decide about people in: ${list(p.domains, AREA_TEXT)}.`,
    'ai_act.prohibited.none_found': () => 'Bee found none of the practices the AI Act forbids.',
    'ai_act.prohibited.found': (p) => `Bee thinks it may do something the AI Act forbids: ${list(p.practices, PRACTICE_TEXT)}.`,
    'ai_act.model.unsure': () => 'Bee could not tell for sure from the name, description and AI instructions.',
    'ai_act.model.unavailable': () => 'Bee could not reach its AI model to check this.',
};

/** The English line for one piece of evidence. */
function textFor(code, params = {}) {
    const fn = TEXT[code];
    return fn ? fn(params || {}) : '';
}

/** Evidence as the API sends it: `{ code, params, text }`. */
function withText(evidence) {
    return (Array.isArray(evidence) ? evidence : []).map(e => ({ code: e.code, params: e.params || {}, text: textFor(e.code, e.params) }));
}

module.exports = { AREA_TEXT, PRACTICE_TEXT, TEXT, textFor, withText };
