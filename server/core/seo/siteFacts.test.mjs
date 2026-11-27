/**
 * The organisation facts a CMS site states in its settings (core/seo/siteFacts.mts).
 *
 * Run: cd server && node --test core/seo/siteFacts.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
    siteFacts, legalNameFrom, postalAddress, registrationIdentifier, organizationFields, statesPrice,
    footerProfiles, headerProfiles, llmsFactLines,
} from './siteFacts.mts';

/** The shape the CMS stores (header nav with a dropdown and children, footer socials as link objects). */
const SITE = {
    name: 'Acme (imported)',
    header: {
        logoText: 'Acme',
        nav: [
            { id: 'n1', label: 'Platform', link: { kind: 'page', pageId: 'p1' },
                dropdown: { columns: [{ items: [{ label: 'LinkedIn', link: { kind: 'external', url: 'https://www.linkedin.com/company/acme' } }] }] } },
            { id: 'n2', label: 'Company', link: { kind: 'page', pageId: 'p2' }, children: [
                { label: 'Docs', link: { kind: 'external', url: 'https://docs.acme.test' } },
                { label: 'Source on GitHub', link: { kind: 'external', url: 'https://github.com/acme/acme', newTab: true } },
            ] },
        ],
    },
    footer: {
        blurb: 'Acme is the AI workspace for firms.',
        copyright: '© 2026 Acme B.V. All rights reserved.',
        socials: [{ id: 's1', platform: 'github', link: { kind: 'external', url: 'https://github.com/acme/acme' } }],
        accountability: {
            address: 'Main street 6 unit 1.12, 1185 XE Amstelveen, Netherlands',
            registration: 'KvK 12345678',
            vat: '',
            links: [{ label: 'info@acme.test', href: 'mailto:info@acme.test' }],
        },
    },
};

test('the facts come from the header brand, the footer blurb, copyright line and accountability block', () => {
    assert.deepEqual(siteFacts(SITE), {
        name: 'Acme',
        legalName: 'Acme B.V.',
        description: 'Acme is the AI workspace for firms.',
        email: 'info@acme.test',
        address: 'Main street 6 unit 1.12, 1185 XE Amstelveen, Netherlands',
        registration: 'KvK 12345678',
        vat: null,
        profiles: ['https://github.com/acme/acme', 'https://www.linkedin.com/company/acme'],
    });
});

test('an empty or missing site states nothing', () => {
    assert.deepEqual(siteFacts(null), {
        name: '', legalName: null, description: null, email: null, address: null, registration: null, vat: null, profiles: [],
    });
});

test('footer socials are read from the stored link object (link.url) as well as href', () => {
    assert.deepEqual(footerProfiles({ socials: [
        { link: { kind: 'external', url: 'https://github.com/acme/acme' } },
        { link: { href: 'https://x.com/acme' } },
        { href: '/internal' },
        { enabled: false, link: { url: 'https://example.social/@acme' } },
    ] }), ['https://github.com/acme/acme', 'https://x.com/acme']);
});

test('only header nav links to a profile host count as profiles', () => {
    assert.deepEqual(headerProfiles(SITE.header), ['https://www.linkedin.com/company/acme', 'https://github.com/acme/acme']);
    assert.deepEqual(headerProfiles({ nav: [{ link: { kind: 'external', url: 'https://evilgithub.com/x' } }] }), []);
});

test('the legal name is the copyright line without the sign, the years and the reservation', () => {
    assert.equal(legalNameFrom('© Acme B.V.'), 'Acme B.V.');
    assert.equal(legalNameFrom('Copyright 2024-2026 Acme Ltd., all rights reserved'), 'Acme Ltd.');
    assert.equal(legalNameFrom('(c) 2026 Acme GmbH'), 'Acme GmbH');
    assert.equal(legalNameFrom('©'), null);
    assert.equal(legalNameFrom(undefined), null);
});

test('an address with street, postal code and town becomes a PostalAddress; anything else stays text', () => {
    assert.deepEqual(postalAddress('Main street 6 unit 1.12, 1185 XE Amstelveen, Netherlands'), {
        '@type': 'PostalAddress', streetAddress: 'Main street 6 unit 1.12', postalCode: '1185 XE',
        addressLocality: 'Amstelveen', addressCountry: 'NL',
    });
    assert.deepEqual(postalAddress('Hauptstraße 1, 10115 Berlin'), {
        '@type': 'PostalAddress', streetAddress: 'Hauptstraße 1', postalCode: '10115', addressLocality: 'Berlin',
    });
    assert.equal(postalAddress('Somewhere in town'), 'Somewhere in town');
    assert.equal(postalAddress('Street 1, Town'), 'Street 1, Town');
});

test('a registration line becomes a PropertyValue with its scheme', () => {
    assert.deepEqual(registrationIdentifier('KvK 12345678'), { '@type': 'PropertyValue', propertyID: 'KvK', value: '12345678' });
    assert.deepEqual(registrationIdentifier('Company number: 0123'), { '@type': 'PropertyValue', propertyID: 'Company number', value: '0123' });
    assert.equal(registrationIdentifier('12345678'), '12345678');
});

test('the Organization fields carry the legal name as alternateName, the address, identifier and contact', () => {
    const fields = organizationFields(siteFacts(SITE));
    assert.equal(fields.legalName, 'Acme B.V.');
    assert.equal(fields.alternateName, 'Acme B.V.');
    assert.equal(fields.email, 'info@acme.test');
    assert.deepEqual(fields.identifier, { '@type': 'PropertyValue', propertyID: 'KvK', value: '12345678' });
    assert.equal(fields.vatID, undefined);
    assert.equal(/** @type {any} */ (fields.address).postalCode, '1185 XE');
    // The same name twice is no alternate name.
    assert.equal(organizationFields({ ...siteFacts(SITE), legalName: 'Acme' }).alternateName, undefined);
});

test('statesPrice sees an amount of money, not the word price', () => {
    for (const s of ['from €6 per user', '€ 6', '6 EUR a month', 'USD 10', '$10', '12,50 €']) assert.ok(statesPrice(s), s);
    for (const s of ['A fixed price agreed first', 'Euro hosting', 'EU AI Act', '', null]) assert.ok(!statesPrice(s), String(s));
});

test('the llms facts leave out a priced blurb', () => {
    const lines = llmsFactLines({ ...siteFacts(SITE), description: 'Acme, from €6 per user per month.' });
    assert.ok(lines.length > 1);
    assert.ok(!lines.some(l => l.includes('€')));
});
