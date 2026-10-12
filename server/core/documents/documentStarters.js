// @typecheck
'use strict';

const TYPES = [
    ['security', 'Security policy / report', 'security', 'Describe the customer environment, applicable controls, responsibilities and open actions. Never claim certification or implemented controls without supplied evidence.'],
    ['proposal', 'Proposal', 'quote', 'Describe the customer need, proposed scope, deliverables, exclusions, price and next steps.'],
    ['invoice', 'Invoice', 'invoice', 'Use supplied invoice identifiers, dates, line items, tax and totals. Never invent banking or tax details.'],
    ['letter', 'Letter', 'letter', 'Use a clear salutation, concise purpose, body and closing.'],
    ['report', 'General report', 'report', 'Start with an executive summary, then findings, evidence and recommendations.'],
];
const DUTCH = {
    'Security policy / report':'Beveiligingsbeleid / rapport', Proposal:'Voorstel', Invoice:'Factuur', Letter:'Brief', 'General report':'Algemeen rapport',
    'Customer name':'Klantnaam', 'Document date':'Documentdatum', Summary:'Samenvatting', Overview:'Overzicht',
    'Customer and document summary':'Samenvatting van klant en document', 'Uses remote access':'Gebruikt externe toegang',
    'Uses cloud services':'Gebruikt clouddiensten', 'Verified remote-access controls':'Geverifieerde maatregelen voor externe toegang',
    'Verified cloud controls':'Geverifieerde cloudmaatregelen', 'Remote access':'Externe toegang', 'Cloud services':'Clouddiensten',
    'Line items':'Factuurregels', Description:'Omschrijving', Amount:'Bedrag', 'Verified total':'Geverifieerd totaal', Total:'Totaal',
};
const DUTCH_INSTRUCTIONS = {
    security:'Beschrijf de klantomgeving, toepasselijke maatregelen, verantwoordelijkheden en open acties. Claim geen certificering of geïmplementeerde maatregelen zonder aangeleverd bewijs.',
    proposal:'Beschrijf de klantbehoefte, voorgestelde scope, resultaten, uitsluitingen, prijs en vervolgstappen.',
    invoice:'Gebruik aangeleverde factuurnummers, datums, factuurregels, belastingen en totalen. Verzin geen bank- of belastinggegevens.',
    letter:'Gebruik een duidelijke aanhef, een beknopt doel, de inhoud en een afsluiting.',
    report:'Begin met een managementsamenvatting, gevolgd door bevindingen, bewijs en aanbevelingen.',
};
function starters(locale = 'en') {
    return [...pageStarters(locale), ...deckStarters(locale)];
}
function pageStarters(locale = 'en') {
    const nl = String(locale).startsWith('nl');
    const t = text => nl ? DUTCH[text] || text : text;
    const p = (key, label, type = 'text', required = true) => ({ key, label:t(label), type, required, summary:t(label),
        instructions:nl ? `Geef de geverifieerde waarde voor ${t(label).toLowerCase()}. Verzin geen klantgegevens.` : `Supply the verified ${label.toLowerCase()}. Do not invent customer facts.` });
    return TYPES.map(([id, englishName, docType, englishInstructions]) => {
        const name = t(englishName), instructions = nl ? DUTCH_INSTRUCTIONS[id] : englishInstructions;
        const parameters = [p('customer.name', 'Customer name'), p('date', 'Document date', 'date'), p('summary', 'Summary')];
        const sections = [{ id: 'overview', title: t('Overview'), summary: t('Customer and document summary'), condition: null }];
        let bodyHtml = `<header class="doc-header"><div class="doc-logo"></div><p>${name} · {{date}}</p></header><h1>${name}</h1><section data-doc-section="overview"><h2>{{customer.name}}</h2><p>{{summary}}</p></section>`;
        if (id === 'security') {
            parameters.push(p('remoteAccess', 'Uses remote access', 'boolean'), p('cloudServices', 'Uses cloud services', 'boolean'), p('remoteControls', 'Verified remote-access controls'), p('cloudControls', 'Verified cloud controls'));
            for (const [sid, title, key, text] of [['remote', 'Remote access', 'remoteAccess', 'remoteControls'], ['cloud', 'Cloud services', 'cloudServices', 'cloudControls']]) {
                sections.push({ id: sid, title:t(title), summary: nl ? `Van toepassing bij gebruik van ${t(title).toLowerCase()}` : `Applies when ${title.toLowerCase()} is used`, condition: { parameter: key, operator: 'equals', value: true } });
                bodyHtml += `<section data-doc-section="${sid}"><h2>${t(title)}</h2><p>{{${text}}}</p></section>`;
            }
        } else if (id === 'invoice' || id === 'proposal') {
            parameters.push({ ...p('lines', 'Line items', 'list'), fields: [p('description', 'Description'), p('amount', 'Amount', 'number')] }, p('total', 'Verified total', 'number'));
            bodyHtml += `<table><thead><tr><th>${t('Description')}</th><th>${t('Amount')}</th></tr></thead><tbody>{{#each lines}}<tr><td>{{description}}</td><td>{{amount}}</td></tr>{{/each}}</tbody></table><p>${t('Total')}: {{total}}</p>`;
        }
        bodyHtml += '<footer class="doc-footer">{{customer.name}} · {{date}}</footer>';
        return { id, name, docType, description: instructions, kind: 'template', bodyHtml,
            css: 'h1 { font-size: 28pt; border-bottom: 3px solid var(--doc-accent); padding-bottom: 12pt; } section { margin: 20pt 0; } th,td { padding: 8pt; text-align:left; border-bottom:1px solid #ddd; } .doc-footer { margin-top:24pt; font-size:9pt; color:var(--doc-muted); }',
            settings: { locale:nl?'nl':'en', contract: { schemaVersion: 1, instructions, parameters, sections }, design: { preset: 'neutral' } } };
    });
}
// ── Presentations ──────────────────────────────────────────────────────
//
// A presentation starter is an OUTLINE (core/documents/deckModel.js grammar)
// with the same {{placeholders}} a document has, so an automation can fill it per
// run. The look is left to the house style: `settings.deck` stays empty.

const DECK_DUTCH = {
    'Pitch deck':'Pitchpresentatie', 'Quarterly review':'Kwartaalrapportage', 'Project kick-off':'Projectkick-off',
    'Presentation title':'Titel van de presentatie', Subtitle:'Ondertitel', Customer:'Klant', Date:'Datum',
    'The challenge':'De uitdaging', 'What we offer':'Wat wij bieden', 'Results':'Resultaten', 'Next steps':'Vervolgstappen', 'Thank you':'Bedankt',
    'Fast':'Snel', 'Live within weeks, not quarters.':'Binnen weken live, niet binnen kwartalen.', 'Safe':'Veilig', 'Your data stays on your own servers.':'Uw data blijft op uw eigen servers.',
    'Proven':'Bewezen', 'Built with customers like you.':'Gebouwd met klanten zoals u.', 'Kick-off — goals and scope':'Kick-off — doelen en scope',
    'Build — weekly demos':'Bouw — wekelijkse demo\u2019s', 'Go-live — training and handover':'Livegang — training en overdracht',
    'Let\u2019s build it together.':'Laten we het samen bouwen.', 'Highlights':'Hoogtepunten', 'Revenue':'Omzet', 'Customers':'Klanten', 'Satisfaction':'Tevredenheid',
    'Revenue per month':'Omzet per maand', 'Costs':'Kosten', 'Top accounts':'Grootste accounts', 'Account':'Account', 'Amount':'Bedrag', 'Change':'Verandering',
    'Outlook':'Vooruitblik', 'What went well':'Wat ging goed', 'What we change':'Wat we anders doen', 'Why':'Waarom', 'Goals':'Doelen', 'Team':'Team', 'Approach':'Aanpak',
    'Discover — interviews and data':'Ontdekken — interviews en data', 'Design — prototype and review':'Ontwerpen — prototype en review', 'Deliver — build, test, go live':'Opleveren — bouwen, testen, live',
    'Questions?':'Vragen?', 'Scope':'Scope', 'Timeline':'Planning', 'Risks':'Risico\u2019s',
};
const DECK_INSTRUCTIONS = {
    pitch: ['Sell the outcome, not the feature list: one problem, one answer, proof, next steps. Keep the customer\u2019s own words.',
        'Verkoop het resultaat, niet de functielijst: \u00e9\u00e9n probleem, \u00e9\u00e9n antwoord, bewijs, vervolgstappen. Gebruik de woorden van de klant.'],
    review: ['Lead with the numbers: KPI tiles first, then the chart, then what changes. Every figure comes from supplied data; never estimate.',
        'Begin met de cijfers: eerst KPI-tegels, dan de grafiek, dan wat er verandert. Elk getal komt uit aangeleverde data; schat nooit.'],
    kickoff: ['Align the room: why, goals, who, how, when, and the risks you already see. Short slides; the discussion is the point.',
        'Zet iedereen op \u00e9\u00e9n lijn: waarom, doelen, wie, hoe, wanneer en de risico\u2019s die je al ziet. Korte slides; het gesprek is het doel.'],
};

function deckStarters(locale = 'en') {
    const nl = String(locale).startsWith('nl');
    const t = (text) => (nl ? DECK_DUTCH[text] || text : text);
    const p = (key, label, type = 'text', required = true) => ({ key, label: t(label), type, required, summary: t(label),
        instructions: nl ? `Geef de geverifieerde waarde voor ${t(label).toLowerCase()}. Verzin geen klantgegevens.` : `Supply the verified ${label.toLowerCase()}. Do not invent customer facts.` });
    const cover = `# {{title}}\n\n{{subtitle}}\n\n`;
    const closing = `## ${t('Thank you')}\n<!-- layout: closing -->\n{{customer.name}} \u00b7 {{date}}\n`;
    const decks = [
        ['deck-pitch', 'Pitch deck', 'pitch', `${cover}## ${t('The challenge')}\n- \u2026\n- \u2026\n\n## ${t('What we offer')}\n### ${t('Fast')} {icon: rocket}\n${t('Live within weeks, not quarters.')}\n### ${t('Safe')} {icon: shield}\n${t('Your data stays on your own servers.')}\n### ${t('Proven')} {icon: badge-check}\n${t('Built with customers like you.')}\n\n## ${t('Next steps')}\n<!-- layout: timeline -->\n- ${t('Kick-off — goals and scope')}\n- ${t('Build — weekly demos')}\n- ${t('Go-live — training and handover')}\n\n## ${t('Thank you')}\n<!-- layout: closing -->\n${t('Let\u2019s build it together.')} \u00b7 {{customer.name}}\n`],
        ['deck-review', 'Quarterly review', 'review', `${cover}## ${t('Highlights')}\n\`\`\`stats\n{{revenue}} | ${t('Revenue')} | {{revenueDelta}} | trending-up\n{{customers}} | ${t('Customers')} | | users\n{{satisfaction}} | ${t('Satisfaction')} | | star\n\`\`\`\n\n## ${t('Revenue per month')}\n\`\`\`chart\ntype: column\nlabels: Jan, Feb, Mar\n${t('Revenue')}: 0, 0, 0\n${t('Costs')}: 0, 0, 0\n\`\`\`\n\n## ${t('Top accounts')}\n| ${t('Account')} | ${t('Amount')} | ${t('Change')} |\n|---|---|---|\n{{#each accounts}}| {{name}} | {{amount}} | {{change}} |\n{{/each}}\n\n## ${t('Outlook')}\n### ${t('What went well')}\n- \u2026\n### ${t('What we change')}\n- \u2026\n\n${closing}`],
        ['deck-kickoff', 'Project kick-off', 'kickoff', `${cover}## ${t('Why')}\n{{summary}}\n\n## ${t('Goals')}\n- \u2026\n- \u2026\n\n## ${t('Approach')}\n<!-- layout: timeline -->\n- ${t('Discover — interviews and data')}\n- ${t('Design — prototype and review')}\n- ${t('Deliver — build, test, go live')}\n\n## ${t('Scope')}\n### ${t('Scope')} {icon: target}\n\u2026\n### ${t('Timeline')} {icon: calendar}\n\u2026\n### ${t('Risks')} {icon: triangle-alert}\n\u2026\n\n## ${t('Questions?')}\n<!-- layout: closing -->\n{{customer.name}} \u00b7 {{date}}\n`],
    ];
    return decks.map(([id, englishName, key, outline]) => {
        const parameters = [p('title', 'Presentation title'), p('subtitle', 'Subtitle', 'text', false), p('customer.name', 'Customer'), p('date', 'Date', 'date')];
        if (key === 'review') {
            parameters.push(p('revenue', 'Revenue'), p('revenueDelta', 'Change', 'text', false), p('customers', 'Customers'), p('satisfaction', 'Satisfaction', 'text', false),
                { ...p('accounts', 'Top accounts', 'list', false), fields: [p('name', 'Account'), p('amount', 'Amount'), p('change', 'Change', 'text', false)] });
        }
        if (key === 'kickoff') parameters.push(p('summary', 'Why'));
        const instructions = DECK_INSTRUCTIONS[key][nl ? 1 : 0];
        return { id, name: t(englishName), docType: 'presentation', description: instructions, kind: 'template', bodyHtml: outline, css: '',
            settings: { locale: nl ? 'nl' : 'en', contract: { schemaVersion: 1, instructions, parameters, sections: [] }, deck: {} } };
    });
}

const guidance = TYPES.map(([, name,, instructions]) => `${name}: ${instructions}`).join('\n');
const deckGuidance = 'Presentation: an outline — "# " title, "## " per slide, "- " bullets, "### " cards with {icon: name}, ```chart and ```stats blocks, <!-- layout: timeline|closing -->, "Notes:" for speaker notes. No HTML, no CSS.';
module.exports = { starters, deckStarters, guidance, deckGuidance };
