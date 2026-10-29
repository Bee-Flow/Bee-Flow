// @typecheck strict
/**
 * The compliance review's findings about one automation the playbook built
 * (staticFindings, compliancePhase.js): what leaves the platform, an AI step
 * without a Privacy Shield, the AI Act transparency duty and the Annex III
 * hint. Pure: every finding is read off the facts, none is a guess.
 */

'use strict';

/**
 * @typedef {import('./compliancePhase').Facts} Facts
 * @typedef {import('./compliancePhase').Finding} Finding
 * @typedef {import('./compliancePhase').Target} Target
 * @typedef {Facts['automations'][number]} AutomationFacts
 * @typedef {ReturnType<typeof import('../copy').copyFor>['finding']} FindingCopy
 * @typedef {{ key: string | undefined, at: Target | null, C: FindingCopy, has: (code: string) => boolean,
 *   personal: Array<{ name: string }>, names: string }} Review  the finding key and target of this automation,
 *   the copy, the frameworks asked for, and the personal columns of the table
 */

/**
 * "integration_action → gmail" — the step type the person sees, and where it
 * actually goes. Falls back to the type alone for a fact object that carries
 * no flow (an older stored artifact), never to a bare arrow.
 * @param {{ outbound?: string[], flow?: { destinations?: string[] } | null }} a
 */
function outboundLabel(a) {
    const types = (a.outbound || []).join(', ');
    const dests = ((a.flow && a.flow.destinations) || []).join(', ');
    return types && dests ? `${types} → ${dests}` : (types || dests);
}

/**
 * The findings about one automation, in review order: the GDPR ones, then the
 * AI Act ones.
 * @param {AutomationFacts} a
 * @param {Review} review
 * @returns {Finding[]}
 */
function automationFindings(a, review) {
    return [...gdprFindings(a, review), ...aiActFindings(a, review)];
}

/**
 * What leaves the platform, and an AI step without a Privacy Shield.
 * @param {AutomationFacts} a
 * @param {Review} review
 * @returns {Finding[]}
 */
function gdprFindings(a, { key, at, C, has, personal, names }) {
    /** @type {Finding[]} */
    const out = [];
    const gdpr = has('GDPR');
    if (gdpr && personal.length && a.outbound.length) {
        out.push({
            code: `outbound_${key}`,
            severity: 'medium',
            framework: 'GDPR',
            article: 'Art. 5(1)(b), 44',
            subject: C.subjectAutomation(a.title),
            // The copy has always called this argument `dests` and has
            // always been handed step types, which name no recipient at
            // all: `integration_action` is Gmail, Nextcloud Talk and
            // LinkedIn at once. Art. 30(1)(d) asks for the categories of
            // RECIPIENTS, so the destination is named beside the type —
            // beside it and not instead of it, because the type is what
            // the person sees on the canvas and has to find.
            why: C.outbound.why(outboundLabel(a), names),
            title: C.outbound.title,
            fix: C.outbound.fix,
            link: 'automation',
            target: at,
        });
    }
    // PRESENCE, deliberately, even though the analyser now knows the
    // ORDER — and the difference is worth writing down because it looks
    // like an oversight.
    //
    // `flow.models_unshielded` counts the models that have no Privacy
    // Shield EARLIER than them, which is the question this finding's own
    // title asks ("no privacy check in front of it"), and a shield dropped
    // at the end of an automation protects nothing that already ran. But the
    // sentence this finding prints is a fixed one — "…and there is no
    // Privacy Shield step in this automation" (copy.js) — and firing it
    // for an automation that has a shield in the wrong place would make the
    // review say something untrue in three languages. Tightening the gate
    // is a COPY change first and a gate change second, and this review's
    // whole credibility rests on every sentence being readable off a fact.
    // Until that copy exists the order travels in `flow.models_unshielded`,
    // where the model reading the facts and the after-the-fact GDPR check
    // (compliance/checks/gdpr/art30-1-d-personal-data-flows.js) both use
    // it — the check states it in its own words and is not gated on this.
    if (gdpr && personal.length && a.aiSteps.length && !a.hasPrivacyStep) {
        out.push({
            code: `ai_no_guard_${key}`,
            severity: 'medium',
            framework: 'GDPR',
            // Art. 25 — data protection by design. NOT AI Act Art. 10,
            // which is data governance for HIGH-RISK systems; claiming it
            // for an extraction step is the kind of overreach this review
            // gets called out for.
            article: 'Art. 25, 32',
            subject: C.subjectAutomation(a.title),
            title: C.aiNoGuard.title,
            why: C.aiNoGuard.why(a.aiSteps.join(', ')),
            fix: C.aiNoGuard.fix,
            link: 'automation',
            target: at,
        });
    }
    return out;
}

/**
 * The AI Act transparency duty and the Annex III hint.
 * @param {AutomationFacts} a
 * @param {Review} review
 * @returns {Finding[]}
 */
function aiActFindings(a, { key, at, C, has }) {
    /** @type {Finding[]} */
    const out = [];
    // The AI Act, from the product's own detector (compliance/aiAct).
    // Only what the signals actually say — an automation that generates
    // nothing and faces nobody triggers no transparency duty at all.
    const sig = a.aiAct;
    if (has('AIA') && sig && sig.contains_ai && sig.generates_content && sig.customer_facing && !sig.disclosure_present) {
        out.push({
            code: `aia_disclosure_${key}`,
            severity: 'high',
            framework: 'AIA',
            article: 'Art. 50(1)',
            subject: C.subjectAutomation(a.title),
            title: C.aiaDisclosure.title,
            why: C.aiaDisclosure.why,
            fix: C.aiaDisclosure.fix,
            link: 'automation',
            target: at,
        });
    }
    // Annex III: a HINT, said as one. The wording must not produce "this may
    // be a high-risk use of AI" — a legal qualification made by keyword
    // match, wrong in both directions (an automation that merely mentions
    // insurance got it; one doing facial recognition got nothing, because
    // five of the ten domains were not in the pattern at all). The pattern
    // now covers all ten (compliance/aiAct/annexIii.js) and what it
    // produces is a pointer to the questionnaire, not a verdict: the ten
    // questions decide, and only an admin answers them.
    if (has('AIA') && sig && sig.annex_iii_hint) {
        // The signals carry the point of the annex per domain; older
        // callers pass only the category names, and then the finding cites
        // the annex as a whole rather than inventing a point.
        const points = Array.isArray(sig.annex_iii_questions)
            ? [...new Set(sig.annex_iii_questions.filter(q => q && q.hint && q.article).map(q => q?.article))]
            : [];
        out.push({
            code: `aia_annex_iii_${key}`,
            severity: 'medium',
            framework: 'AIA',
            article: points.length ? points.join(', ') : 'Annex III',
            subject: C.subjectAutomation(a.title),
            title: C.aiaAnnexIii.title,
            why: C.aiaAnnexIii.why((sig.annex_iii_categories || []).join(', ') || C.aiaAnnexIii.area),
            fix: C.aiaAnnexIii.fix,
            link: 'automation',
            target: at,
        });
    }
    return out;
}

module.exports = { automationFindings, outboundLabel };
