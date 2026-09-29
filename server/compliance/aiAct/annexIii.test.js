'use strict';

/**
 * Annex III as ten questions.
 *
 * The bug this file exists to keep closed: the ladder asked about FOUR of the
 * ten domains and offered them as one all-or-nothing denial, so ticking every
 * chip on screen recorded "this is not a high-risk AI system" on behalf of
 * someone who was never asked about biometrics, critical infrastructure, law
 * enforcement, migration or the administration of justice. A product that
 * records a legal declaration nobody made is worse than one that records none.
 *
 * Run: node --test --test-force-exit server/compliance/aiAct/annexIii.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const annex = require('./annexIii');
const assessMod = require('./assess');

const ALL = annex.ANNEX_III_IDS;

test('the catalogue is the whole of Annex III — ten domains, each citing its own point', () => {
    assert.deepStrictEqual(ALL, [
        'biometrics', 'critical_infrastructure', 'education', 'employment', 'essential_services',
        'credit', 'insurance', 'law_enforcement', 'migration', 'justice',
    ]);
    // Annex III numbers its points 1..8; essential services is point 5, split
    // into (a) public services, (b) creditworthiness, (c) insurance pricing.
    const byId = Object.fromEntries(annex.ANNEX_III_DOMAINS.map(d => [d.id, d]));
    assert.strictEqual(byId.biometrics.article, 'Annex III(1)');
    assert.strictEqual(byId.employment.article, 'Annex III(4)');
    assert.deepStrictEqual(
        [byId.essential_services.article, byId.credit.article, byId.insurance.article],
        ['Annex III(5)(a)', 'Annex III(5)(b)', 'Annex III(5)(c)'],
    );
    assert.strictEqual(byId.justice.article, 'Annex III(8)');
    for (const d of annex.ANNEX_III_DOMAINS) {
        assert.ok(d.point >= 1 && d.point <= 8, `${d.id} cites a point outside Annex III`);
        assert.ok(d.labelKey.startsWith('compliance.annex_q_'), `${d.id} has no question key`);
    }
});

test('the five domains the old regex could not see are now asked about', () => {
    // The pattern that decided "high risk" before covered recruitment, credit,
    // education, essential services and insurance. A routine doing facial
    // recognition, border control or recidivism scoring produced NOTHING.
    for (const id of ['biometrics', 'critical_infrastructure', 'law_enforcement', 'migration', 'justice']) {
        assert.ok(ALL.includes(id), `${id} is not in the catalogue`);
    }
    assert.deepStrictEqual(annex.hintsIn('Gezichtsherkenning op de bezoekersbalie'), ['biometrics']);
    assert.deepStrictEqual(annex.hintsIn('Score the recidivism risk of a suspect'), ['law_enforcement']);
    assert.deepStrictEqual(annex.hintsIn('Beoordeelt een visumaanvraag'), ['migration']);
});

test('questionsFor always returns all ten, hinted first — a pattern orders, it never filters', () => {
    const q = annex.questionsFor('Wij screenen sollicitanten');
    assert.strictEqual(q.length, 10, 'showing only what a pattern matched is the old false negative in a new shape');
    assert.strictEqual(q[0].id, 'employment');
    assert.strictEqual(q[0].hint, true);
    assert.strictEqual(q[0].article, 'Annex III(4)');
    assert.deepStrictEqual(q.filter(x => x.hint).map(x => x.id), ['employment']);
    // catalogue order survives inside each half
    assert.deepStrictEqual(q.slice(1).map(x => x.id), ALL.filter(id => id !== 'employment'));

    const none = annex.questionsFor('Weekly digest');
    assert.strictEqual(none.length, 10);
    assert.deepStrictEqual(none.map(x => x.id), ALL, 'no hint at all still asks all ten, in catalogue order');
    assert.ok(none.every(x => x.hint === false));
});

test("'no' needs all ten — four answers can never add up to a declaration", () => {
    const partial = { employment: 'no', credit: 'no', education: 'no', essential_services: 'no' };
    assert.strictEqual(annex.answerFromDomains(partial), 'unknown',
        'this is exactly what the four-chip ladder recorded as "not high-risk"');
    assert.deepStrictEqual(annex.unansweredDomains(partial).sort(), [
        'biometrics', 'critical_infrastructure', 'insurance', 'justice', 'law_enforcement', 'migration',
    ].sort());

    const all = Object.fromEntries(ALL.map(id => [id, 'no']));
    assert.strictEqual(annex.answerFromDomains(all), 'no');
    assert.deepStrictEqual(annex.unansweredDomains(all), []);

    assert.strictEqual(annex.answerFromDomains({ ...all, migration: 'yes' }), 'yes');
    // one yes decides even while the rest are open: high risk does not wait
    assert.strictEqual(annex.answerFromDomains({ biometrics: 'yes' }), 'yes');
    assert.strictEqual(annex.answerFromDomains({}), 'unknown');
    assert.strictEqual(annex.answerFromDomains(null), 'unknown');
});

test('an answer cites the point of the annex that made it high-risk', () => {
    assert.deepStrictEqual(annex.articlesFor({ employment: 'yes' }), ['Annex III(4)']);
    assert.deepStrictEqual(annex.articlesFor({ credit: 'yes', insurance: 'yes' }),
        ['Annex III(5)(b)', 'Annex III(5)(c)'], 'both halves of point 5 are named, not "point 5"');
    assert.deepStrictEqual(annex.articlesFor({ employment: 'no' }), [], 'a "no" cites nothing');
    assert.deepStrictEqual(annex.articlesFor({}), []);
});

test('normalizeDomainAnswers is an allow-list and has no absent state', () => {
    const d = annex.normalizeDomainAnswers({ employment: 'yes', nonsense: 'yes', biometrics: 'perhaps' });
    assert.deepStrictEqual(Object.keys(d).sort(), [...ALL].sort());
    assert.strictEqual(d.employment, 'yes');
    assert.strictEqual(d.biometrics, 'unknown', 'a value outside yes/no is not an answer');
    assert.ok(!('nonsense' in d));
    assert.strictEqual(annex.normalizeDomainAnswers(true).justice, 'unknown');
    assert.strictEqual(annex.anyAnswered({}), false);
    assert.strictEqual(annex.anyAnswered({ justice: 'no' }), true);
});

test('assess derives the single answer from the ten, and a pre-existing row keeps its own', () => {
    const S = (o = {}) => ({ contains_ai: true, ...o });

    // The four-chip ladder's exact payload: answer 'no', nothing per domain.
    // Old rows must keep their meaning — dropping it would silently
    // un-declare every assessment already on file.
    const legacy = assessMod.normalizeAnswers({ annex_iii: { answer: 'no' } });
    assert.strictEqual(legacy.annex_iii.answer, 'no');
    assert.strictEqual(assessMod.outcome(S(), legacy), 'minimal');

    // But a client that DOES send domains cannot reach 'no' with four of them,
    // whatever it puts in `answer`.
    const four = assessMod.normalizeAnswers({
        annex_iii: { answer: 'no', domains: { employment: 'no', credit: 'no', education: 'no', essential_services: 'no' } },
    });
    assert.strictEqual(four.annex_iii.answer, 'unknown');
    assert.strictEqual(assessMod.outcome(S(), four), 'minimal', 'unknown is not high risk either — it is just not a declaration');

    const ten = assessMod.normalizeAnswers({
        annex_iii: { domains: Object.fromEntries(ALL.map(id => [id, 'no'])) },
    });
    assert.strictEqual(ten.annex_iii.answer, 'no');

    const hit = assessMod.assess(S(), { annex_iii: { domains: { law_enforcement: 'yes' } } });
    assert.strictEqual(hit.outcome, 'high_risk');
    assert.deepStrictEqual(hit.annex_iii_articles, ['Annex III(6)'], 'the verdict names the point it rests on');
    assert.strictEqual(hit.annex_iii_open.length, 9);

    const open = assessMod.assess(S(), {});
    assert.deepStrictEqual(open.annex_iii_articles, []);
    assert.deepStrictEqual(open.annex_iii_open, ALL, 'nothing answered → all ten still open');
});
