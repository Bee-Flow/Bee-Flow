#!/usr/bin/env node
/**
 * Test-invoice generator - realistic PDF invoices for the Nextcloud Invoices
 * folder, so an automation can be asked to read them and sort by supplier /
 * year / month.
 *
 * WHY GENERATED, NOT HAND-WRITTEN: the point of the exercise is volume you can
 * turn up. Everything here is derived from a seeded PRNG, and every seed is
 * built from (supplier, year, month) - NEVER from a running index. So the set
 * produced by --count 10 is exactly the first 10 of --count 200: re-running
 * with a bigger number adds OLDER invoices and leaves the existing files
 * byte-identical. Nothing is renumbered, nothing is re-uploaded differently.
 *
 * EACH SUPPLIER HAS ITS OWN LAYOUT. That is the part that makes this a real
 * test: a different letterhead, table style, font, language, date format,
 * number format, currency and VAT treatment per supplier. An extractor that
 * only works because every document has the same shape will fail here, which
 * is exactly the point.
 *
 * The PDFs carry a real text layer (pdfkit), so server/core/documents/
 * attachmentExtractor's pdfjs path reads them with no OCR configured.
 *
 * Usage:
 *   node server/scripts/generate-test-invoices.js --count 10 --list
 *   node server/scripts/generate-test-invoices.js --count 10 --out /tmp/invoices
 *   node server/scripts/generate-test-invoices.js --count 10 --upload
 *   node server/scripts/generate-test-invoices.js --count 50 --upload   # adds 40 older ones
 *
 * Upload target defaults to the local sandbox (http://localhost:8081, admin).
 * Override with --nc-url / --nc-user / --nc-pass or NC_URL / NC_USER / NC_PASS.
 */

const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

// The newest month any invoice can carry. Fixed on purpose: the walk goes
// BACKWARD from here, so raising --count only ever adds older documents.
const ANCHOR = '2026-02';
const DEFAULT_SEED = 'beeflow-invoices-v1';

// --------------------------- deterministic randomness ---------------------
function hash32(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
function rng(seedStr) {
    let a = hash32(seedStr);
    const next = function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    // Warm-up. Seeds here differ by only a character or two ("...|2026-1" vs
    // "...|2026-2"), and mulberry32's FIRST output stays correlated with the
    // seed, so a bare first draw made every supplier's cadence coin land the
    // same way. Three discards decorrelate it; without this, p=0.3 behaved
    // like p=0.7 and every invoice piled into the newest month.
    next(); next(); next();
    return next;
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const between = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

// --------------------------- formatting per locale ------------------------
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_NL = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function fmtMoney(amount, style) {
    const fixed = amount.toFixed(2);
    const [int, dec] = fixed.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    if (style === 'eu') return `${grouped.replace(/ /g, '.')},${dec}`;      // 1.234,56
    if (style === 'ch') return `${grouped.replace(/ /g, "'")}.${dec}`;      // 1'234.56
    return `${grouped.replace(/ /g, ',')}.${dec}`;                          // 1,234.56
}
function fmtDate(d, style) {
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const yyyy = d.getUTCFullYear();
    switch (style) {
        case 'nl': return `${dd}-${mm}-${yyyy}`;
        case 'de': return `${dd}.${mm}.${yyyy}`;
        case 'fr': return `${dd}/${mm}/${yyyy}`;
        case 'us': return `${mm}/${dd}/${yyyy}`;
        case 'uk': return `${d.getUTCDate()} ${MONTHS_EN[d.getUTCMonth()]} ${yyyy}`;
        case 'nl-long': return `${d.getUTCDate()} ${MONTHS_NL[d.getUTCMonth()]} ${yyyy}`;
        default: return `${yyyy}-${mm}-${dd}`;
    }
}

// --------------------------- the suppliers --------------------------------
// cadence 'monthly'  -> one invoice every month (subscriptions, utilities)
// cadence 'frequent' -> most months
// cadence 'rare'     -> occasionally
const SUPPLIERS = [
    {
        key: 'vandijk', layout: 'classicNL', cadence: 'frequent',
        name: 'Van Dijk Kantoorbenodigdheden B.V.',
        address: ['Ambachtsweg 42', '3542 DG Utrecht', 'Nederland'],
        email: 'facturen@vandijk-kantoor.nl', phone: '+31 30 245 88 10',
        vatLabel: 'BTW-nummer', vatNumber: 'NL8123.45.678.B01',
        regLabel: 'KvK', regNumber: '30145782',
        iban: 'NL22 RABO 0145 7823 91',
        currency: 'EUR', symbol: '€', vatRate: 0.21, moneyStyle: 'eu', dateStyle: 'nl',
        lang: 'nl', accent: '#1B4F8A', terms: 30,
        numberFmt: (y, seq) => `${y}-${String(seq).padStart(4, '0')}`,
        items: [
            ['Printpapier A4 80 g/m2, doos 5 pak', 'doos', 24.5, 38.9],
            ['Tonercartridge HP 415A zwart', 'stuk', 89, 134],
            ['Archiefordner 80 mm, 10 stuks', 'set', 18.75, 26.4],
            ['Notitieblokken A5 gelinieerd, 10 stuks', 'set', 11.2, 16.8],
            ['Balpennen blauw, doos 50', 'doos', 14.9, 22.5],
            ['Bureaulamp LED dimbaar', 'stuk', 54, 79],
        ],
    },
    {
        key: 'nordlicht', layout: 'germanUtility', cadence: 'monthly',
        name: 'Nordlicht Energie GmbH',
        address: ['Hafenstraße 118', '20359 Hamburg', 'Deutschland'],
        email: 'rechnung@nordlicht-energie.de', phone: '+49 40 5566 210',
        vatLabel: 'USt-IdNr.', vatNumber: 'DE283774915',
        regLabel: 'Handelsregister', regNumber: 'HRB 84129 Hamburg',
        iban: 'DE44 2007 0000 0123 4567 89',
        currency: 'EUR', symbol: '€', vatRate: 0.19, moneyStyle: 'eu', dateStyle: 'de',
        lang: 'de', accent: '#0F5B3E', terms: 14,
        numberFmt: (y, seq) => `RE-${y}-${String(seq).padStart(5, '0')}`,
        items: [
            ['Netznutzung Grundpreis', 'Monat', 42.5, 42.5],
            ['Arbeitspreis Strom HT', 'kWh', 0.289, 0.341],
            ['Arbeitspreis Strom NT', 'kWh', 0.218, 0.262],
            ['Messstellenbetrieb', 'Monat', 11.9, 15.4],
            ['CO2-Abgabe', 'Monat', 8.25, 13.6],
        ],
    },
    {
        key: 'brightpath', layout: 'modernSaaS', cadence: 'frequent',
        name: 'Brightpath Software Ltd',
        address: ['Unit 7, Kingsway House', '103 Kingsway, London WC2B 6QX', 'United Kingdom'],
        email: 'billing@brightpath.io', phone: '+44 20 7946 0812',
        vatLabel: 'VAT Reg. No.', vatNumber: 'GB 412 8873 21',
        regLabel: 'Company No.', regNumber: '09984412',
        iban: 'GB29 NWBK 6016 1331 9268 19',
        currency: 'GBP', symbol: '£', vatRate: 0.20, moneyStyle: 'en', dateStyle: 'uk',
        lang: 'en', accent: '#5B2BD9', terms: 14,
        numberFmt: (y, seq) => `BP${y}${String(seq).padStart(4, '0')}`,
        items: [
            ['Brightpath Platform - Team plan', 'seat/month', 18, 24],
            ['Advanced analytics add-on', 'seat/month', 6, 9],
            ['Priority support retainer', 'month', 120, 240],
            ['API overage - additional 100k calls', 'block', 15, 45],
        ],
    },
    {
        key: 'molenaar', layout: 'receiptSmall', cadence: 'rare',
        name: 'Café Molenaar Catering',
        address: ['Molenstraat 7', '6811 GT Arnhem'],
        email: 'info@cafe-voorbeeld.nl', phone: '026 - 000 00 00',
        vatLabel: 'BTW', vatNumber: 'NL001234567B21',
        regLabel: 'KvK', regNumber: '09182736',
        iban: 'NL91 INGB 0002 4455 66',
        currency: 'EUR', symbol: '€', vatRate: 0.09, moneyStyle: 'eu', dateStyle: 'nl-long',
        lang: 'nl', accent: '#8A5A1B', terms: 14,
        numberFmt: (y, seq) => `F-${y}-${seq % 100}`,
        items: [
            ['Lunchbuffet standaard', 'persoon', 12.5, 18.5],
            ['Belegde broodjes assorti', 'stuk', 3.25, 4.75],
            ['Koffie / thee arrangement', 'persoon', 2.4, 3.9],
            ['Verse jus d\'orange, 1 liter', 'kan', 6.5, 8.9],
            ['Borrelhapjes warm', 'schaal', 24, 42],
        ],
    },
    {
        key: 'techparts', layout: 'frenchFacture', cadence: 'frequent',
        name: 'TechParts Distribution SA',
        address: ['Rue de l\'Industrie 24', '4020 Liège', 'Belgique'],
        email: 'facturation@techparts.be', phone: '+32 4 223 71 40',
        vatLabel: 'N° TVA', vatNumber: 'BE 0478.512.336',
        regLabel: 'RPM', regNumber: 'Liège 0478.512.336',
        iban: 'BE68 5390 0754 7034',
        currency: 'EUR', symbol: '€', vatRate: 0.21, moneyStyle: 'eu', dateStyle: 'fr',
        lang: 'fr', accent: '#B3202C', terms: 30,
        numberFmt: (y, seq) => `FA${y}/${String(seq).padStart(3, '0')}`,
        items: [
            ['Disque SSD NVMe 1 To', 'pièce', 78, 112],
            ['Barrette mémoire DDR5 32 Go', 'pièce', 96, 148],
            ['Switch réseau 24 ports géré', 'pièce', 245, 389],
            ['Câble RJ45 Cat6a 3 m', 'pièce', 4.2, 7.8],
            ['Alimentation redondante 750 W', 'pièce', 189, 265],
        ],
    },
    {
        key: 'cloudhost', layout: 'usNetTerms', cadence: 'frequent',
        name: 'CloudHost Services Inc.',
        address: ['1200 Harbor Blvd, Suite 900', 'Austin, TX 78701', 'United States'],
        email: 'ar@cloudhost-services.com', phone: '+1 (512) 555-0148',
        vatLabel: 'Tax ID (EIN)', vatNumber: '47-2216839',
        regLabel: 'DUNS', regNumber: '08-114-9920',
        iban: 'Chase, ABA 021000021, Acct 8842019776',
        currency: 'USD', symbol: '$', vatRate: 0, moneyStyle: 'en', dateStyle: 'us',
        lang: 'en', accent: '#0B7285', terms: 30,
        vatNote: 'No sales tax applied - services delivered outside the United States; reverse charge applies in the customer jurisdiction.',
        numberFmt: (y, seq) => `INV-${100000 + seq}`,
        items: [
            ['Compute - c5.2xlarge instance hours', 'hour', 0.34, 0.41],
            ['Object storage - standard tier', 'GB-month', 0.021, 0.026],
            ['Outbound data transfer', 'GB', 0.085, 0.11],
            ['Managed Postgres - db.m6g.large', 'month', 218, 318],
            ['Snapshot retention', 'GB-month', 0.05, 0.07],
        ],
    },
    {
        key: 'groen', layout: 'lawFirmSerif', cadence: 'rare',
        name: 'Groen & Partners Advocaten N.V.',
        address: ['Weteringschans 165', '1017 XD Amsterdam', 'Nederland'],
        email: 'declaraties@groenpartners.nl', phone: '+31 20 530 44 00',
        vatLabel: 'BTW-identificatienummer', vatNumber: 'NL8098.12.445.B01',
        regLabel: 'KvK Amsterdam', regNumber: '34112298',
        iban: 'NL18 ABNA 0512 3344 55',
        currency: 'EUR', symbol: '€', vatRate: 0.21, moneyStyle: 'eu', dateStyle: 'nl-long',
        lang: 'nl', accent: '#2F3E2F', terms: 21,
        numberFmt: (y, seq) => `${String(y).slice(2)}.${String(seq).padStart(4, '0')}`,
        items: [
            ['Juridisch advies, mr. A. Groen (partner)', 'uur', 295, 295],
            ['Contractbeoordeling, mw. mr. S. de Wit', 'uur', 225, 225],
            ['Correspondentie en overleg wederpartij', 'uur', 225, 265],
            ['Kantoorkosten en verschotten', 'post', 42, 168],
            ['Uittreksel KvK en aktekosten', 'post', 94, 288],
        ],
    },
    {
        key: 'stadler', layout: 'swissFreight', cadence: 'frequent',
        name: 'Stadler Logistik AG',
        address: ['Industriestrasse 9', '8304 Wallisellen', 'Schweiz'],
        email: 'fakturierung@stadler-logistik.ch', phone: '+41 44 878 22 60',
        vatLabel: 'MWST-Nr.', vatNumber: 'CHE-114.882.907 MWST',
        regLabel: 'UID', regNumber: 'CHE-114.882.907',
        iban: 'CH93 0076 2011 6238 5295 7',
        currency: 'CHF', symbol: 'CHF', vatRate: 0.081, moneyStyle: 'ch', dateStyle: 'de',
        lang: 'de', accent: '#8C1D1D', terms: 30,
        numberFmt: (y, seq) => `${y}${String(seq).padStart(4, '0')}-SL`,
        items: [
            ['Sammelgut Sendung Zone 2', 'Sendung', 68, 142],
            ['Express-Zuschlag 24h', 'Sendung', 45, 45],
            ['Palettentausch Europalette', 'Stück', 12.5, 12.5],
            ['Zollabfertigung Export', 'Vorgang', 55, 95],
            ['Lagergebühr', 'Palette/Woche', 8.5, 14],
        ],
    },
];

const CADENCE_P = { monthly: 1, frequent: 0.3, rare: 0.12 };

// The customer. One buyer across all suppliers - this is their invoice inbox.
const CUSTOMER = {
    name: 'Bee Flow B.V.',
    attn: 'Crediteurenadministratie',
    address: ['Stationsplein 45', '3013 AK Rotterdam', 'Nederland'],
    vat: 'NL8623.41.109.B01', kvk: '78129034',
};

// --------------------------- invoice construction -------------------------
function monthsBack(anchor, n) {
    const [y, m] = anchor.split('-').map(Number);
    const total = y * 12 + (m - 1) - n;
    return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function buildInvoice(sup, year, month, seed) {
    const r = rng(`${seed}|${sup.key}|${year}-${month}`);
    const day = between(r, 1, 28);
    const date = new Date(Date.UTC(year, month - 1, day));
    const due = new Date(Date.UTC(year, month - 1, day + sup.terms));

    // Sequence number implied by the month, so it looks like a real ledger and
    // never shifts when more invoices are generated.
    const seq = (year - 2020) * 12 + month + hash32(sup.key) % 40;
    const number = sup.numberFmt(year, seq);

    const nItems = between(r, 1, Math.min(5, sup.items.length));
    const chosen = [];
    const pool = [...sup.items];
    for (let i = 0; i < nItems; i++) {
        const [desc, unit, lo, hi] = pool.splice(Math.floor(r() * pool.length), 1)[0];
        const unitPrice = Math.round((lo + r() * (hi - lo)) * 100) / 100;
        // Cheap per-unit lines are metered (big quantities); expensive ones are not.
        const qty = unitPrice < 1 ? between(r, 200, 9000)
            : unitPrice < 20 ? between(r, 2, 40)
                : between(r, 1, 8);
        chosen.push({ desc, unit, qty, unitPrice, amount: Math.round(qty * unitPrice * 100) / 100 });
    }

    const subtotal = Math.round(chosen.reduce((s, i) => s + i.amount, 0) * 100) / 100;
    const vat = Math.round(subtotal * sup.vatRate * 100) / 100;
    const total = Math.round((subtotal + vat) * 100) / 100;

    const poNumber = r() < 0.55 ? `PO-${between(r, 10000, 99999)}` : null;
    const ourRef = pick(r, ['M. Jansen', 'T. Smit', 'A. el Amrani', 'S. Bakker', 'L. Visser']);

    return { supplier: sup, date, due, number, items: chosen, subtotal, vat, total, poNumber, ourRef };
}

// Filenames deliberately say little: the automation has to read the document,
// not the name. The style is stable per invoice.
function fileNameFor(inv, seed) {
    const r = rng(`${seed}|name|${inv.supplier.key}|${inv.number}`);
    const n = between(r, 1000, 9999);
    const d = inv.date;
    const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const styles = [
        `scan_${iso}_${n}.pdf`,
        `invoice_${n}.pdf`,
        `doc${String(n).padStart(6, '0')}.pdf`,
        `factuur-${n}.pdf`,
        `IMG_${iso.replace(/-/g, '')}_${String(n).slice(0, 3)}.pdf`,
        `${inv.number.replace(/[^A-Za-z0-9._-]/g, '-')}.pdf`,
    ];
    return pick(r, styles);
}

// --------------------------- shared drawing helpers -----------------------
const PAGE = { margin: 50, width: 595.28, height: 841.89 };
const contentWidth = PAGE.width - PAGE.margin * 2;

function moneyOf(inv, amount) { return `${inv.supplier.symbol} ${fmtMoney(amount, inv.supplier.moneyStyle)}`; }

function footerBlock(doc, inv, y) {
    const s = inv.supplier;
    doc.font('Helvetica').fontSize(7.5).fillColor('#666666');
    doc.text(`${s.name} | ${s.address.join(', ')} | ${s.email} | ${s.phone}`, PAGE.margin, y, { width: contentWidth, align: 'center' });
    doc.text(`${s.vatLabel}: ${s.vatNumber} | ${s.regLabel}: ${s.regNumber} | IBAN: ${s.iban}`, PAGE.margin, y + 11, { width: contentWidth, align: 'center' });
    doc.fillColor('black');
}

// --------------------------- layout 1: classic NL -------------------------
// Blue rule at the top, left wordmark, boxed meta table on the right,
// zebra-striped line table, totals right-aligned.
function classicNL(doc, inv) {
    const s = inv.supplier;
    doc.rect(0, 0, PAGE.width, 8).fill(s.accent);
    doc.fillColor('black').font('Helvetica-Bold').fontSize(17).text(s.name, PAGE.margin, 48);
    doc.font('Helvetica').fontSize(8.5).fillColor('#444444')
        .text(s.address.join('  |  '), PAGE.margin, 72)
        .text(`${s.phone}   ${s.email}`, PAGE.margin, 84);

    doc.fillColor('black').font('Helvetica-Bold').fontSize(26).text('FACTUUR', PAGE.margin, 120);

    const bx = PAGE.width - PAGE.margin - 200;
    doc.rect(bx, 118, 200, 74).fillAndStroke('#F2F6FA', s.accent);
    doc.font('Helvetica').fontSize(9);
    const meta = [
        ['Factuurnummer', inv.number],
        ['Factuurdatum', fmtDate(inv.date, s.dateStyle)],
        ['Vervaldatum', fmtDate(inv.due, s.dateStyle)],
        ['Betalingstermijn', `${s.terms} dagen`],
    ];
    let my = 126;
    for (const [k, v] of meta) {
        doc.font('Helvetica').fillColor('#555555').text(k, bx + 8, my, { width: 95 });
        doc.font('Helvetica-Bold').fillColor('black').text(v, bx + 103, my, { width: 89, align: 'right' });
        my += 16;
    }

    doc.font('Helvetica').fontSize(9).fillColor('#555555').text('Factuuradres', PAGE.margin, 200);
    doc.fillColor('black').font('Helvetica-Bold').fontSize(10).text(CUSTOMER.name, PAGE.margin, 214);
    doc.font('Helvetica').fontSize(9).text([CUSTOMER.attn, ...CUSTOMER.address].join('\n'), PAGE.margin, 228);
    if (inv.poNumber) doc.text(`Uw referentie: ${inv.poNumber}`, PAGE.margin, 288);
    doc.text(`Contactpersoon: ${inv.ourRef}`, PAGE.margin, inv.poNumber ? 300 : 288);

    let y = 330;
    const cols = [PAGE.margin, 300, 350, 415, PAGE.width - PAGE.margin];
    doc.rect(PAGE.margin, y, contentWidth, 20).fill(s.accent);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
    doc.text('Omschrijving', cols[0] + 6, y + 6);
    doc.text('Aantal', cols[1], y + 6, { width: cols[2] - cols[1] - 6, align: 'right' });
    doc.text('Stukprijs', cols[2], y + 6, { width: cols[3] - cols[2] - 6, align: 'right' });
    doc.text('Bedrag', cols[3], y + 6, { width: cols[4] - cols[3] - 6, align: 'right' });
    y += 20;

    doc.font('Helvetica').fontSize(9);
    inv.items.forEach((it, i) => {
        if (i % 2 === 1) doc.rect(PAGE.margin, y, contentWidth, 18).fill('#F6F8FA');
        doc.fillColor('black');
        doc.text(it.desc, cols[0] + 6, y + 5, { width: cols[1] - cols[0] - 12 });
        doc.text(`${it.qty} ${it.unit}`, cols[1], y + 5, { width: cols[2] - cols[1] - 6, align: 'right' });
        doc.text(fmtMoney(it.unitPrice, s.moneyStyle), cols[2], y + 5, { width: cols[3] - cols[2] - 6, align: 'right' });
        doc.text(fmtMoney(it.amount, s.moneyStyle), cols[3], y + 5, { width: cols[4] - cols[3] - 6, align: 'right' });
        y += 18;
    });

    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#CCCCCC').stroke();
    y += 10;
    const tot = [
        ['Subtotaal', moneyOf(inv, inv.subtotal), false],
        [`BTW ${Math.round(s.vatRate * 100)}%`, moneyOf(inv, inv.vat), false],
        ['Totaal te betalen', moneyOf(inv, inv.total), true],
    ];
    for (const [k, v, bold] of tot) {
        if (bold) doc.rect(330, y - 3, PAGE.width - PAGE.margin - 330, 20).fill('#F2F6FA');
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9.5).fillColor('black');
        doc.text(k, 340, y + 2, { width: 110 });
        doc.text(v, 450, y + 2, { width: PAGE.width - PAGE.margin - 450, align: 'right' });
        y += bold ? 24 : 16;
    }

    doc.font('Helvetica').fontSize(9).fillColor('#333333').text(
        `Wij verzoeken u het totaalbedrag van ${moneyOf(inv, inv.total)} binnen ${s.terms} dagen over te maken op ${s.iban} onder vermelding van factuurnummer ${inv.number}.`,
        PAGE.margin, y + 20, { width: contentWidth });

    footerBlock(doc, inv, PAGE.height - 70);
}

// --------------------------- layout 2: German utility ---------------------
// Address in the DIN window position on the left, meta column on the right,
// grey banded table, formal Rechnung wording, consumption-style line items.
function germanUtility(doc, inv) {
    const s = inv.supplier;
    doc.rect(PAGE.margin, 40, 4, 46).fill(s.accent);
    doc.fillColor(s.accent).font('Helvetica-Bold').fontSize(15).text(s.name, PAGE.margin + 14, 42);
    doc.fillColor('#555555').font('Helvetica').fontSize(8).text(s.address.join(' . '), PAGE.margin + 14, 62);
    doc.text(`${s.phone} . ${s.email}`, PAGE.margin + 14, 73);

    doc.fontSize(6.5).fillColor('#888888').text(`${s.name} . ${s.address[0]} . ${s.address[1]}`, PAGE.margin, 128);
    doc.moveTo(PAGE.margin, 136).lineTo(PAGE.margin + 240, 136).strokeColor('#DDDDDD').stroke();
    doc.fillColor('black').font('Helvetica').fontSize(10)
        .text([CUSTOMER.name, CUSTOMER.attn, ...CUSTOMER.address].join('\n'), PAGE.margin, 144);

    const rx = PAGE.width - PAGE.margin - 190;
    doc.fontSize(8.5);
    const meta = [
        ['Rechnungsnummer', inv.number],
        ['Rechnungsdatum', fmtDate(inv.date, s.dateStyle)],
        ['Leistungszeitraum', `${String(inv.date.getUTCMonth() + 1).padStart(2, '0')}/${inv.date.getUTCFullYear()}`],
        ['Kundennummer', `KD-${100000 + (hash32(CUSTOMER.name) % 90000)}`],
        ['Zählernummer', `1ESY${hash32(s.key + inv.number) % 10000000}`],
        ['Fällig am', fmtDate(inv.due, s.dateStyle)],
    ];
    let my = 128;
    for (const [k, v] of meta) {
        doc.font('Helvetica').fillColor('#666666').text(k, rx, my, { width: 100 });
        doc.font('Helvetica-Bold').fillColor('black').text(v, rx + 100, my, { width: 90, align: 'right' });
        my += 14;
    }

    doc.fillColor('black').font('Helvetica-Bold').fontSize(15)
        .text(`Rechnung Nr. ${inv.number}`, PAGE.margin, 240);
    doc.font('Helvetica').fontSize(9.5).fillColor('#333333').text(
        `Sehr geehrte Damen und Herren,\n\nfür die Belieferung Ihrer Abnahmestelle stellen wir Ihnen den Zeitraum ${String(inv.date.getUTCMonth() + 1).padStart(2, '0')}/${inv.date.getUTCFullYear()} wie folgt in Rechnung.`,
        PAGE.margin, 264, { width: contentWidth });

    let y = 320;
    const cols = [PAGE.margin, 268, 330, 400, 465, PAGE.width - PAGE.margin];
    doc.rect(PAGE.margin, y, contentWidth, 18).fill('#E8E8E8');
    doc.fillColor('#222222').font('Helvetica-Bold').fontSize(8.5);
    ['Position', 'Menge', 'Einheit', 'Einzelpreis', 'Betrag'].forEach((h, i) => {
        if (i === 0) doc.text(h, cols[0] + 5, y + 5);
        else doc.text(h, cols[i], y + 5, { width: cols[i + 1] - cols[i] - 5, align: 'right' });
    });
    y += 18;
    doc.font('Helvetica').fontSize(8.5);
    inv.items.forEach((it) => {
        doc.fillColor('black');
        doc.text(it.desc, cols[0] + 5, y + 5, { width: cols[1] - cols[0] - 10 });
        doc.text(String(it.qty), cols[1], y + 5, { width: cols[2] - cols[1] - 5, align: 'right' });
        doc.text(it.unit, cols[2], y + 5, { width: cols[3] - cols[2] - 5, align: 'right' });
        doc.text(fmtMoney(it.unitPrice, s.moneyStyle), cols[3], y + 5, { width: cols[4] - cols[3] - 5, align: 'right' });
        doc.text(fmtMoney(it.amount, s.moneyStyle), cols[4], y + 5, { width: cols[5] - cols[4] - 5, align: 'right' });
        y += 17;
        doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#EEEEEE').stroke();
    });

    y += 14;
    doc.fontSize(9);
    const rows = [
        ['Nettobetrag', fmtMoney(inv.subtotal, s.moneyStyle)],
        [`zzgl. ${(s.vatRate * 100).toFixed(0)} % MwSt.`, fmtMoney(inv.vat, s.moneyStyle)],
    ];
    for (const [k, v] of rows) {
        doc.font('Helvetica').fillColor('#333333').text(k, 330, y, { width: 120 });
        doc.fillColor('black').text(`${s.symbol} ${v}`, 450, y, { width: PAGE.width - PAGE.margin - 450, align: 'right' });
        y += 15;
    }
    doc.rect(330, y, PAGE.width - PAGE.margin - 330, 22).fill(s.accent);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(11);
    doc.text('Rechnungsbetrag', 336, y + 6, { width: 120 });
    doc.text(moneyOf(inv, inv.total), 450, y + 6, { width: PAGE.width - PAGE.margin - 456, align: 'right' });
    y += 38;

    doc.fillColor('#333333').font('Helvetica').fontSize(9).text(
        `Bitte überweisen Sie den Rechnungsbetrag bis zum ${fmtDate(inv.due, s.dateStyle)} unter Angabe der Rechnungsnummer ${inv.number} auf das Konto ${s.iban}.`,
        PAGE.margin, y, { width: contentWidth });

    footerBlock(doc, inv, PAGE.height - 70);
}

// --------------------------- layout 3: modern SaaS ------------------------
// Purple wordmark, no table rules, generous whitespace, amount-due hero block
// top right. Deliberately shares almost nothing with the others.
function modernSaaS(doc, inv) {
    const s = inv.supplier;
    doc.circle(PAGE.margin + 9, 58, 9).fill(s.accent);
    doc.fillColor('black').font('Helvetica-Bold').fontSize(14).text('Brightpath', PAGE.margin + 26, 51);
    doc.font('Helvetica').fontSize(8).fillColor('#777777').text(s.address.join(', '), PAGE.margin, 78);

    doc.rect(PAGE.width - PAGE.margin - 190, 44, 190, 66).fill('#F5F2FE');
    doc.fillColor(s.accent).font('Helvetica').fontSize(8.5).text('AMOUNT DUE', PAGE.width - PAGE.margin - 178, 54);
    doc.fillColor('black').font('Helvetica-Bold').fontSize(20).text(moneyOf(inv, inv.total), PAGE.width - PAGE.margin - 178, 68, { width: 166 });
    doc.font('Helvetica').fontSize(8).fillColor('#666666').text(`Due ${fmtDate(inv.due, s.dateStyle)}`, PAGE.width - PAGE.margin - 178, 93);

    doc.fillColor('black').font('Helvetica-Bold').fontSize(24).text('Invoice', PAGE.margin, 140);
    doc.font('Helvetica').fontSize(9.5).fillColor('#666666')
        .text(`${inv.number}  .  issued ${fmtDate(inv.date, s.dateStyle)}`, PAGE.margin, 170);

    doc.fontSize(8).fillColor('#999999').text('BILLED TO', PAGE.margin, 202);
    doc.fillColor('black').font('Helvetica-Bold').fontSize(10).text(CUSTOMER.name, PAGE.margin, 216);
    doc.font('Helvetica').fontSize(9).fillColor('#444444').text(CUSTOMER.address.join('\n'), PAGE.margin, 230);
    doc.text(`VAT ${CUSTOMER.vat}`, PAGE.margin, 272);

    doc.fontSize(8).fillColor('#999999').text('BILLING PERIOD', 320, 202);
    doc.fillColor('black').font('Helvetica').fontSize(9.5)
        .text(`${MONTHS_EN[inv.date.getUTCMonth()]} ${inv.date.getUTCFullYear()}`, 320, 216);
    if (inv.poNumber) {
        doc.fontSize(8).fillColor('#999999').text('PURCHASE ORDER', 320, 238);
        doc.fillColor('black').fontSize(9.5).text(inv.poNumber, 320, 252);
    }

    let y = 310;
    doc.font('Helvetica').fontSize(8).fillColor('#999999');
    doc.text('DESCRIPTION', PAGE.margin, y);
    doc.text('QTY', 330, y, { width: 60, align: 'right' });
    doc.text('RATE', 395, y, { width: 70, align: 'right' });
    doc.text('AMOUNT', 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
    y += 12;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#E4E4E4').stroke();
    y += 12;

    inv.items.forEach((it) => {
        doc.fillColor('black').font('Helvetica-Bold').fontSize(9.5).text(it.desc, PAGE.margin, y, { width: 260 });
        doc.font('Helvetica').fillColor('#777777').fontSize(8).text(`per ${it.unit}`, PAGE.margin, y + 13, { width: 260 });
        doc.fillColor('black').fontSize(9.5);
        doc.text(String(it.qty), 330, y, { width: 60, align: 'right' });
        doc.text(fmtMoney(it.unitPrice, s.moneyStyle), 395, y, { width: 70, align: 'right' });
        doc.text(fmtMoney(it.amount, s.moneyStyle), 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
        y += 30;
    });

    doc.moveTo(330, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#E4E4E4').stroke();
    y += 12;
    const rows = [['Subtotal', inv.subtotal, false], [`VAT at ${(s.vatRate * 100).toFixed(0)}%`, inv.vat, false], ['Total due', inv.total, true]];
    for (const [k, v, bold] of rows) {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 9.5).fillColor(bold ? 'black' : '#555555');
        doc.text(k, 330, y, { width: 130 });
        doc.fillColor('black').text(moneyOf(inv, v), 460, y, { width: PAGE.width - PAGE.margin - 460, align: 'right' });
        y += bold ? 22 : 16;
    }

    doc.font('Helvetica').fontSize(8.5).fillColor('#666666').text(
        `Payment by bank transfer to ${s.iban}, quoting ${inv.number}. ${s.vatLabel} ${s.vatNumber}. Registered in England and Wales, ${s.regLabel} ${s.regNumber}.`,
        PAGE.margin, y + 26, { width: contentWidth });
    doc.text('Thank you for your business.', PAGE.margin, y + 62);
}

// --------------------------- layout 4: small receipt ----------------------
// Narrow, monospaced, no colour - the kind of thing a small caterer prints.
function receiptSmall(doc, inv) {
    const s = inv.supplier;
    const W = 300;
    const L = (PAGE.width - W) / 2;
    const RULE = '='.repeat(46);
    const DASH = '-'.repeat(46);
    doc.font('Courier-Bold').fontSize(12).text(s.name.toUpperCase(), L, 60, { width: W, align: 'center' });
    doc.font('Courier').fontSize(8).text(s.address.join('\n'), L, 78, { width: W, align: 'center' });
    doc.text(`tel. ${s.phone}`, L, 100, { width: W, align: 'center' });
    doc.text(`${s.vatLabel} ${s.vatNumber}  ${s.regLabel} ${s.regNumber}`, L, 111, { width: W, align: 'center' });

    doc.text(RULE, L, 130, { width: W, align: 'center' });
    doc.font('Courier-Bold').fontSize(11).text('FACTUUR', L, 144, { width: W, align: 'center' });
    doc.font('Courier').fontSize(9);
    doc.text(`Factuurnr : ${inv.number}`, L, 164, { width: W });
    doc.text(`Datum     : ${fmtDate(inv.date, s.dateStyle)}`, L, 176, { width: W });
    doc.text(`Vervalt   : ${fmtDate(inv.due, s.dateStyle)}`, L, 188, { width: W });
    doc.text(DASH, L, 202, { width: W });
    doc.text('Aan:', L, 216, { width: W });
    doc.text([CUSTOMER.name, ...CUSTOMER.address].join('\n'), L + 10, 228, { width: W - 10 });
    doc.text(RULE, L, 276, { width: W });

    let y = 292;
    doc.fontSize(8.5);
    inv.items.forEach((it) => {
        doc.text(it.desc, L, y, { width: W });
        y += 11;
        doc.text(`  ${it.qty} ${it.unit} x ${fmtMoney(it.unitPrice, s.moneyStyle)}`, L, y, { width: W - 90 });
        doc.text(fmtMoney(it.amount, s.moneyStyle), L + W - 90, y, { width: 90, align: 'right' });
        y += 14;
    });

    doc.text(DASH, L, y, { width: W });
    y += 14;
    const rows = [
        ['Subtotaal', fmtMoney(inv.subtotal, s.moneyStyle)],
        [`BTW ${(s.vatRate * 100).toFixed(0)}%`, fmtMoney(inv.vat, s.moneyStyle)],
    ];
    for (const [k, v] of rows) {
        doc.font('Courier').text(k, L, y, { width: W - 90 });
        doc.text(v, L + W - 90, y, { width: 90, align: 'right' });
        y += 12;
    }
    doc.font('Courier-Bold').fontSize(10);
    doc.text('TOTAAL', L, y + 4, { width: W - 90 });
    doc.text(`${s.symbol} ${fmtMoney(inv.total, s.moneyStyle)}`, L + W - 90, y + 4, { width: 90, align: 'right' });
    doc.font('Courier').fontSize(8.5);
    doc.text(RULE, L, y + 22, { width: W });
    doc.text(`Gaarne voldoen binnen ${s.terms} dagen op`, L, y + 38, { width: W, align: 'center' });
    doc.text(s.iban, L, y + 50, { width: W, align: 'center' });
    doc.text(`o.v.v. ${inv.number}`, L, y + 62, { width: W, align: 'center' });
    doc.text('Bedankt en tot ziens!', L, y + 84, { width: W, align: 'center' });
}

// --------------------------- layout 5: French facture ---------------------
// Serif, two-column header, red rules, fully bordered grid, TVA recap and the
// mandatory late-payment sentence at the bottom.
function frenchFacture(doc, inv) {
    const s = inv.supplier;
    doc.rect(PAGE.margin, 44, contentWidth, 2).fill(s.accent);
    doc.fillColor('black').font('Times-Bold').fontSize(16).text(s.name, PAGE.margin, 54);
    doc.font('Times-Roman').fontSize(9).fillColor('#333333').text(s.address.join('\n'), PAGE.margin, 76);
    doc.text(`Tél. ${s.phone}\n${s.email}`, PAGE.margin, 118);
    doc.text(`${s.vatLabel} ${s.vatNumber}\n${s.regLabel} ${s.regNumber}`, PAGE.margin, 144);

    const rx = 330;
    doc.rect(rx, 54, PAGE.width - PAGE.margin - rx, 108).strokeColor('#BBBBBB').stroke();
    doc.font('Times-Bold').fontSize(10).fillColor('#333333').text('CLIENT', rx + 10, 64);
    doc.font('Times-Roman').fontSize(10).fillColor('black')
        .text([CUSTOMER.name, CUSTOMER.attn, ...CUSTOMER.address].join('\n'), rx + 10, 80);
    doc.fontSize(9).text(`TVA: ${CUSTOMER.vat}`, rx + 10, 142);

    doc.fillColor(s.accent).font('Times-Bold').fontSize(20).text(`FACTURE N° ${inv.number}`, PAGE.margin, 182);
    doc.fillColor('black').font('Times-Roman').fontSize(10);
    doc.text(`Date de facturation : ${fmtDate(inv.date, s.dateStyle)}`, PAGE.margin, 210);
    doc.text(`Échéance : ${fmtDate(inv.due, s.dateStyle)} (${s.terms} jours)`, PAGE.margin, 224);
    if (inv.poNumber) doc.text(`Référence commande : ${inv.poNumber}`, PAGE.margin, 238);

    let y = 266;
    const cols = [PAGE.margin, 280, 340, 400, 465, PAGE.width - PAGE.margin];
    const head = ['Désignation', 'Quantité', 'Unité', 'P.U. HT', 'Montant HT'];
    doc.rect(PAGE.margin, y, contentWidth, 20).fillAndStroke('#FBEDEE', '#BBBBBB');
    doc.fillColor('#7A1219').font('Times-Bold').fontSize(9);
    head.forEach((h, i) => doc.text(h, cols[i] + 4, y + 6, { width: cols[i + 1] - cols[i] - 8, align: i ? 'right' : 'left' }));
    y += 20;

    doc.font('Times-Roman').fontSize(9.5).fillColor('black');
    inv.items.forEach((it) => {
        const h = 20;
        doc.rect(PAGE.margin, y, contentWidth, h).strokeColor('#DDDDDD').stroke();
        for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], y).lineTo(cols[i], y + h).stroke();
        doc.fillColor('black');
        doc.text(it.desc, cols[0] + 4, y + 6, { width: cols[1] - cols[0] - 8 });
        doc.text(String(it.qty), cols[1] + 4, y + 6, { width: cols[2] - cols[1] - 8, align: 'right' });
        doc.text(it.unit, cols[2] + 4, y + 6, { width: cols[3] - cols[2] - 8, align: 'right' });
        doc.text(fmtMoney(it.unitPrice, s.moneyStyle), cols[3] + 4, y + 6, { width: cols[4] - cols[3] - 8, align: 'right' });
        doc.text(fmtMoney(it.amount, s.moneyStyle), cols[4] + 4, y + 6, { width: cols[5] - cols[4] - 8, align: 'right' });
        y += h;
    });

    y += 18;
    doc.font('Times-Bold').fontSize(8.5).fillColor('#333333').text('Récapitulatif TVA', PAGE.margin, y);
    doc.font('Times-Roman').fontSize(8.5).fillColor('black');
    doc.text(`Base HT ${fmtMoney(inv.subtotal, s.moneyStyle)} - Taux ${(s.vatRate * 100).toFixed(0)} % - TVA ${fmtMoney(inv.vat, s.moneyStyle)}`, PAGE.margin, y + 14);

    let ty = y;
    const rows = [['Total HT', inv.subtotal], [`TVA ${(s.vatRate * 100).toFixed(0)} %`, inv.vat]];
    doc.fontSize(10);
    for (const [k, v] of rows) {
        doc.font('Times-Roman').fillColor('black').text(k, 360, ty, { width: 110 });
        doc.text(moneyOf(inv, v), 465, ty, { width: PAGE.width - PAGE.margin - 465, align: 'right' });
        ty += 16;
    }
    doc.rect(360, ty, PAGE.width - PAGE.margin - 360, 22).fillAndStroke('#FBEDEE', s.accent);
    doc.fillColor('#7A1219').font('Times-Bold').fontSize(11);
    doc.text('Total TTC', 366, ty + 6, { width: 100 });
    doc.text(moneyOf(inv, inv.total), 465, ty + 6, { width: PAGE.width - PAGE.margin - 471, align: 'right' });

    doc.fillColor('#333333').font('Times-Italic').fontSize(8).text(
        `Paiement par virement sur le compte ${s.iban} en mentionnant la référence ${inv.number}. En cas de retard de paiement, une pénalité de 3 fois le taux d'intérêt légal ainsi qu'une indemnité forfaitaire de 40 € pour frais de recouvrement seront exigibles.`,
        PAGE.margin, ty + 46, { width: contentWidth, align: 'justify' });
}

// --------------------------- layout 6: US net terms -----------------------
// Bill To / Invoice Details two-box header, teal rules, Remit To panel, and
// no VAT at all - a different money shape from every European one.
function usNetTerms(doc, inv) {
    const s = inv.supplier;
    doc.rect(PAGE.margin, 46, 30, 30).fill(s.accent);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(15).text('CH', PAGE.margin + 5, 54);
    doc.fillColor('black').fontSize(14).text(s.name, PAGE.margin + 40, 48);
    doc.font('Helvetica').fontSize(8.5).fillColor('#555555').text(s.address.join(' . '), PAGE.margin + 40, 66);

    doc.fillColor(s.accent).font('Helvetica-Bold').fontSize(28)
        .text('INVOICE', PAGE.width - PAGE.margin - 170, 44, { width: 170, align: 'right' });
    doc.fillColor('#444444').font('Helvetica').fontSize(9)
        .text(`${inv.number}`, PAGE.width - PAGE.margin - 170, 76, { width: 170, align: 'right' });

    doc.moveTo(PAGE.margin, 100).lineTo(PAGE.width - PAGE.margin, 100).strokeColor(s.accent).lineWidth(1.5).stroke().lineWidth(1);

    const boxW = (contentWidth - 14) / 2;
    doc.rect(PAGE.margin, 116, boxW, 86).strokeColor('#DDDDDD').stroke();
    doc.rect(PAGE.margin + boxW + 14, 116, boxW, 86).strokeColor('#DDDDDD').stroke();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(s.accent).text('BILL TO', PAGE.margin + 8, 124);
    doc.fillColor('black').font('Helvetica').fontSize(9.5)
        .text([CUSTOMER.name, CUSTOMER.attn, ...CUSTOMER.address].join('\n'), PAGE.margin + 8, 138);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(s.accent).text('INVOICE DETAILS', PAGE.margin + boxW + 22, 124);
    doc.font('Helvetica').fontSize(9.5);
    const det = [
        ['Invoice date', fmtDate(inv.date, s.dateStyle)],
        ['Terms', `Net ${s.terms}`],
        ['Due date', fmtDate(inv.due, s.dateStyle)],
        ['PO number', inv.poNumber || 'N/A'],
        ['Account manager', inv.ourRef],
    ];
    let dy = 138;
    for (const [k, v] of det) {
        doc.fillColor('#666666').text(k, PAGE.margin + boxW + 22, dy, { width: 95 });
        doc.fillColor('black').text(v, PAGE.margin + boxW + 117, dy, { width: boxW - 125, align: 'right' });
        dy += 13;
    }

    let y = 226;
    doc.rect(PAGE.margin, y, contentWidth, 22).fill(s.accent);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(9);
    doc.text('SERVICE', PAGE.margin + 8, y + 7);
    doc.text('USAGE', 320, y + 7, { width: 70, align: 'right' });
    doc.text('UNIT PRICE', 395, y + 7, { width: 75, align: 'right' });
    doc.text('AMOUNT', 475, y + 7, { width: PAGE.width - PAGE.margin - 483, align: 'right' });
    y += 22;
    doc.font('Helvetica').fontSize(9);
    inv.items.forEach((it, i) => {
        if (i % 2 === 0) doc.rect(PAGE.margin, y, contentWidth, 19).fill('#F4FAFB');
        doc.fillColor('black');
        doc.text(it.desc, PAGE.margin + 8, y + 5, { width: 300 });
        doc.text(`${it.qty} ${it.unit}`, 320, y + 5, { width: 70, align: 'right' });
        doc.text(`$${fmtMoney(it.unitPrice, s.moneyStyle)}`, 395, y + 5, { width: 75, align: 'right' });
        doc.text(`$${fmtMoney(it.amount, s.moneyStyle)}`, 475, y + 5, { width: PAGE.width - PAGE.margin - 483, align: 'right' });
        y += 19;
    });

    y += 14;
    doc.font('Helvetica').fontSize(9.5).fillColor('#555555').text('Subtotal', 360, y, { width: 110 });
    doc.fillColor('black').text(moneyOf(inv, inv.subtotal), 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
    y += 16;
    doc.fillColor('#555555').text('Sales tax', 360, y, { width: 110 });
    doc.fillColor('black').text('$ 0.00', 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
    y += 20;
    doc.rect(360, y, PAGE.width - PAGE.margin - 360, 24).fill(s.accent);
    doc.fillColor('white').font('Helvetica-Bold').fontSize(12).text('TOTAL DUE (USD)', 366, y + 7, { width: 130 });
    doc.text(moneyOf(inv, inv.total), 470, y + 7, { width: PAGE.width - PAGE.margin - 476, align: 'right' });
    y += 42;

    doc.rect(PAGE.margin, y, contentWidth, 54).fillAndStroke('#F7F7F7', '#DDDDDD');
    doc.fillColor('#444444').font('Helvetica-Bold').fontSize(8).text('REMIT TO', PAGE.margin + 8, y + 8);
    doc.font('Helvetica').fontSize(8.5).fillColor('black')
        .text(`${s.iban}\n${s.vatLabel}: ${s.vatNumber} . ${s.regLabel}: ${s.regNumber}`, PAGE.margin + 8, y + 21, { width: contentWidth - 16 });
    doc.fontSize(7.5).fillColor('#666666').text(s.vatNote, PAGE.margin, y + 64, { width: contentWidth });
}

// --------------------------- layout 7: law firm ---------------------------
// Centred serif letterhead, ruled Declaratie specification, hourly lines and
// a different vocabulary entirely (declaratienummer, dossier, honorarium).
function lawFirmSerif(doc, inv) {
    const s = inv.supplier;
    doc.font('Times-Bold').fontSize(19).fillColor(s.accent)
        .text('GROEN & PARTNERS', PAGE.margin, 56, { width: contentWidth, align: 'center', characterSpacing: 2 });
    doc.font('Times-Roman').fontSize(9).fillColor('#555555')
        .text('A D V O C A T E N', PAGE.margin, 80, { width: contentWidth, align: 'center' });
    doc.moveTo(PAGE.margin + 120, 96).lineTo(PAGE.width - PAGE.margin - 120, 96).strokeColor(s.accent).stroke();
    doc.fontSize(8).fillColor('#555555')
        .text(`${s.address.join(' . ')} . ${s.phone} . ${s.email}`, PAGE.margin, 104, { width: contentWidth, align: 'center' });

    doc.fillColor('black').font('Times-Roman').fontSize(10)
        .text([CUSTOMER.name, `T.a.v. ${CUSTOMER.attn}`, ...CUSTOMER.address].join('\n'), PAGE.margin, 150);

    doc.text(`Amsterdam, ${fmtDate(inv.date, s.dateStyle)}`, 340, 150, { width: PAGE.width - PAGE.margin - 340, align: 'right' });
    doc.text(`Declaratienummer ${inv.number}`, 340, 166, { width: PAGE.width - PAGE.margin - 340, align: 'right' });
    doc.text(`Dossier ${String(hash32(inv.number) % 90000 + 10000)}`, 340, 182, { width: PAGE.width - PAGE.margin - 340, align: 'right' });

    doc.font('Times-Bold').fontSize(13).text('DECLARATIE', PAGE.margin, 226);
    doc.font('Times-Roman').fontSize(10).fillColor('#333333').text(
        `Inzake de door ons kantoor verrichte werkzaamheden in de periode ${MONTHS_NL[inv.date.getUTCMonth()]} ${inv.date.getUTCFullYear()} doen wij u onderstaande specificatie toekomen.`,
        PAGE.margin, 248, { width: contentWidth });

    let y = 292;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#999999').stroke();
    y += 8;
    doc.font('Times-Bold').fontSize(9.5).fillColor('black');
    doc.text('Specificatie', PAGE.margin, y, { width: 280 });
    doc.text('Uren', 330, y, { width: 55, align: 'right' });
    doc.text('Tarief', 392, y, { width: 70, align: 'right' });
    doc.text('Bedrag', 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
    y += 16;
    doc.moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#999999').stroke();
    y += 10;

    doc.font('Times-Roman').fontSize(10);
    inv.items.forEach((it) => {
        doc.text(it.desc, PAGE.margin, y, { width: 280 });
        doc.text(it.unit === 'uur' ? String(it.qty) : '-', 330, y, { width: 55, align: 'right' });
        doc.text(it.unit === 'uur' ? fmtMoney(it.unitPrice, s.moneyStyle) : '-', 392, y, { width: 70, align: 'right' });
        doc.text(fmtMoney(it.amount, s.moneyStyle), 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
        y += 18;
    });

    y += 6;
    doc.moveTo(330, y).lineTo(PAGE.width - PAGE.margin, y).strokeColor('#999999').stroke();
    y += 10;
    const rows = [['Honorarium en kosten', inv.subtotal], [`Omzetbelasting ${(s.vatRate * 100).toFixed(0)}%`, inv.vat]];
    for (const [k, v] of rows) {
        doc.font('Times-Roman').fontSize(10).text(k, 330, y, { width: 130 });
        doc.text(moneyOf(inv, v), 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });
        y += 16;
    }
    doc.moveTo(330, y + 2).lineTo(PAGE.width - PAGE.margin, y + 2).strokeColor('#333333').stroke();
    doc.moveTo(330, y + 4).lineTo(PAGE.width - PAGE.margin, y + 4).stroke();
    y += 12;
    doc.font('Times-Bold').fontSize(11);
    doc.text('Totaal van deze declaratie', 330, y, { width: 140 });
    doc.text(moneyOf(inv, inv.total), 470, y, { width: PAGE.width - PAGE.margin - 470, align: 'right' });

    doc.font('Times-Roman').fontSize(9.5).fillColor('#333333').text(
        `Wij verzoeken u vriendelijk het bedrag van ${moneyOf(inv, inv.total)} binnen ${s.terms} dagen na dagtekening te voldoen op ${s.iban} ten name van Stichting Beheer Derdengelden Groen & Partners, onder vermelding van declaratienummer ${inv.number}.`,
        PAGE.margin, y + 40, { width: contentWidth });
    doc.font('Times-Italic').fontSize(9).text('Op onze dienstverlening zijn de algemene voorwaarden van toepassing, gedeponeerd bij de Kamer van Koophandel te Amsterdam.', PAGE.margin, y + 92, { width: contentWidth });

    footerBlock(doc, inv, PAGE.height - 60);
}

// --------------------------- layout 8: Swiss freight ----------------------
// Boxed letterhead, shipment reference line, hard-bordered grid, and a
// QR-bill style payment part below a dotted tear line.
function swissFreight(doc, inv) {
    const s = inv.supplier;
    doc.rect(PAGE.margin, 44, contentWidth, 54).fillAndStroke('#FAFAFA', '#CCCCCC');
    doc.fillColor(s.accent).font('Helvetica-Bold').fontSize(16).text(s.name, PAGE.margin + 10, 54);
    doc.fillColor('#444444').font('Helvetica').fontSize(8).text(`${s.address.join(' . ')}`, PAGE.margin + 10, 74);
    doc.text(`${s.phone} . ${s.email} . ${s.vatLabel} ${s.vatNumber}`, PAGE.margin + 10, 85);

    doc.fillColor('black').font('Helvetica-Bold').fontSize(14).text('RECHNUNG', PAGE.margin, 118);
    doc.font('Helvetica').fontSize(9);
    const meta = [
        ['Rechnung Nr.', inv.number],
        ['Datum', fmtDate(inv.date, s.dateStyle)],
        ['Zahlbar bis', fmtDate(inv.due, s.dateStyle)],
        ['Kundennr.', `K-${hash32(CUSTOMER.name) % 90000 + 10000}`],
    ];
    let my = 118;
    for (const [k, v] of meta) {
        doc.font('Helvetica').fillColor('#666666').text(k, 360, my, { width: 90 });
        doc.font('Helvetica-Bold').fillColor('black').text(v, 450, my, { width: PAGE.width - PAGE.margin - 450, align: 'right' });
        my += 13;
    }

    doc.font('Helvetica').fillColor('#666666').fontSize(8).text('RECHNUNGSADRESSE', PAGE.margin, 150);
    doc.fillColor('black').fontSize(10).text([CUSTOMER.name, ...CUSTOMER.address].join('\n'), PAGE.margin, 164);
    doc.fontSize(9).fillColor('#666666').text(`Sendungsreferenz: SL-${hash32(inv.number) % 900000 + 100000}   .   Auftraggeber: ${inv.ourRef}`, PAGE.margin, 226);

    let y = 250;
    const cols = [PAGE.margin, 275, 345, 420, PAGE.width - PAGE.margin];
    doc.rect(PAGE.margin, y, contentWidth, 20).fillAndStroke('#EFEFEF', '#999999');
    doc.fillColor('black').font('Helvetica-Bold').fontSize(8.5);
    ['Leistung', 'Menge', 'Ansatz', 'Betrag CHF'].forEach((h, i) =>
        doc.text(h, cols[i] + 5, y + 6, { width: cols[i + 1] - cols[i] - 10, align: i ? 'right' : 'left' }));
    y += 20;
    doc.font('Helvetica').fontSize(9);
    inv.items.forEach((it) => {
        const h = 19;
        doc.rect(PAGE.margin, y, contentWidth, h).strokeColor('#BBBBBB').stroke();
        for (let i = 1; i < cols.length - 1; i++) doc.moveTo(cols[i], y).lineTo(cols[i], y + h).stroke();
        doc.fillColor('black');
        doc.text(it.desc, cols[0] + 5, y + 5, { width: cols[1] - cols[0] - 10 });
        doc.text(`${it.qty} ${it.unit}`, cols[1] + 5, y + 5, { width: cols[2] - cols[1] - 10, align: 'right' });
        doc.text(fmtMoney(it.unitPrice, s.moneyStyle), cols[2] + 5, y + 5, { width: cols[3] - cols[2] - 10, align: 'right' });
        doc.text(fmtMoney(it.amount, s.moneyStyle), cols[3] + 5, y + 5, { width: cols[4] - cols[3] - 10, align: 'right' });
        y += h;
    });

    y += 12;
    const rows = [['Total netto', inv.subtotal], [`MWST ${(s.vatRate * 100).toFixed(1)} %`, inv.vat]];
    for (const [k, v] of rows) {
        doc.font('Helvetica').fontSize(9.5).fillColor('#333333').text(k, 340, y, { width: 120 });
        doc.fillColor('black').text(fmtMoney(v, s.moneyStyle), 460, y, { width: PAGE.width - PAGE.margin - 460, align: 'right' });
        y += 15;
    }
    doc.rect(340, y, PAGE.width - PAGE.margin - 340, 22).fillAndStroke('#F6E9E9', s.accent);
    doc.fillColor(s.accent).font('Helvetica-Bold').fontSize(11);
    doc.text('Total CHF', 346, y + 6, { width: 110 });
    doc.text(fmtMoney(inv.total, s.moneyStyle), 460, y + 6, { width: PAGE.width - PAGE.margin - 466, align: 'right' });
    y += 44;

    doc.strokeColor('#999999').dash(3, { space: 3 }).moveTo(PAGE.margin, y).lineTo(PAGE.width - PAGE.margin, y).stroke().undash();
    y += 12;
    doc.fillColor('black').font('Helvetica-Bold').fontSize(9).text('Zahlteil', PAGE.margin, y);
    doc.font('Helvetica').fontSize(8.5).fillColor('#333333');
    doc.text(`Konto / Zahlbar an\n${s.iban}\n${s.name}\n${s.address.join(', ')}`, PAGE.margin, y + 14, { width: 240 });
    doc.text(`Referenz\n${inv.number}\n\nWährung  CHF        Betrag  ${fmtMoney(inv.total, s.moneyStyle)}`, PAGE.margin + 260, y + 14, { width: 240 });
}

const LAYOUTS = { classicNL, germanUtility, modernSaaS, receiptSmall, frenchFacture, usNetTerms, lawFirmSerif, swissFreight };

// --------------------------- render one PDF -------------------------------
function renderPdf(inv, outPath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({
            size: 'A4', margin: PAGE.margin,
            info: {
                Title: `Invoice ${inv.number} - ${inv.supplier.name}`,
                Author: inv.supplier.name,
                Subject: `Invoice ${inv.number}`,
                Keywords: 'invoice',
                CreationDate: inv.date,
            },
        });
        const stream = fs.createWriteStream(outPath);
        doc.pipe(stream);
        LAYOUTS[inv.supplier.layout](doc, inv);
        doc.end();
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

// --------------------------- the plan (walk backward) ---------------------
const WINDOW_MONTHS = 120;

function planInvoices(count, seed, anchor) {
    // 1. Which (supplier, month) pairs exist at all. The coin is seeded ONLY by
    //    supplier+month, so it never depends on how many invoices were asked
    //    for: the same pairs exist for --count 10 and --count 500.
    const emissions = [];
    for (let back = 0; back < WINDOW_MONTHS; back++) {
        const { year, month } = monthsBack(anchor, back);
        for (const sup of SUPPLIERS) {
            const r = rng(`${seed}|emit|${sup.key}|${year}-${month}`);
            if (r() <= CADENCE_P[sup.cadence]) emissions.push({ sup, year, month, back });
        }
    }

    // 2. Rank each supplier's own invoices newest-first, then take rank 0 of
    //    every supplier before anyone's rank 1. A small batch therefore shows
    //    ALL EIGHT LAYOUTS and still spans several months and both years,
    //    instead of piling the newest month's invoices up first. Because an
    //    emission's rank depends only on that supplier's own history, raising
    //    --count only ever appends - it never reshuffles or renumbers what an
    //    earlier run already produced.
    const seen = {};
    for (const e of emissions) {
        seen[e.sup.key] = (seen[e.sup.key] || 0);
        e.rank = seen[e.sup.key]++;
    }
    emissions.sort((a, b) =>
        a.rank - b.rank
        || a.back - b.back
        || hash32(`${seed}${a.sup.key}`) - hash32(`${seed}${b.sup.key}`));

    return emissions.slice(0, count).map(e => buildInvoice(e.sup, e.year, e.month, seed));
}

// --------------------------- WebDAV upload --------------------------------
function basic(cfg) {
    return 'Basic ' + Buffer.from(`${cfg.user}:${cfg.pass}`).toString('base64');
}
async function ensureFolder(cfg) {
    const url = `${cfg.url.replace(/\/$/, '')}/remote.php/dav/files/${encodeURIComponent(cfg.user)}/${cfg.folder}`;
    const res = await fetch(url, { method: 'MKCOL', headers: { Authorization: basic(cfg) } });
    // 405 = it already exists, which is the normal case.
    if (![201, 405].includes(res.status)) throw new Error(`MKCOL ${cfg.folder} -> ${res.status}`);
}
async function uploadFile(cfg, remoteName, localPath) {
    const url = `${cfg.url.replace(/\/$/, '')}/remote.php/dav/files/${encodeURIComponent(cfg.user)}/${cfg.folder}/${encodeURIComponent(remoteName)}`;
    const res = await fetch(url, {
        method: 'PUT',
        headers: { Authorization: basic(cfg), 'Content-Type': 'application/pdf' },
        body: fs.readFileSync(localPath),
    });
    if (!res.ok && res.status !== 204) {
        const body = await res.text().catch(() => '');
        throw new Error(`PUT ${remoteName} -> ${res.status} ${body.slice(0, 200)}`);
    }
    return res.status;
}

// --------------------------- CLI ------------------------------------------
function arg(name, dflt) {
    const i = process.argv.indexOf(`--${name}`);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

function reportLine(inv, i, name) {
    return `${String(i + 1).padStart(3)}  ${fmtDate(inv.date, 'iso')}  ${inv.supplier.name.padEnd(36)} ${inv.number.padEnd(14)} ${inv.supplier.currency} ${fmtMoney(inv.total, inv.supplier.moneyStyle).padStart(10)}  ${name}`;
}

async function main() {
    const count = Number(arg('count', 10));
    const seed = arg('seed', DEFAULT_SEED);
    const anchor = arg('anchor', ANCHOR);
    const outDir = arg('out', path.join(require('os').tmpdir(), 'beeflow-test-invoices'));

    const plan = planInvoices(count, seed, anchor);
    const byS = {};
    for (const inv of plan) byS[inv.supplier.name] = (byS[inv.supplier.name] || 0) + 1;
    const months = [...new Set(plan.map(i => `${i.date.getUTCFullYear()}-${String(i.date.getUTCMonth() + 1).padStart(2, '0')}`))].sort();

    if (flag('list')) {
        console.log(`Plan for --count ${count} (anchor ${anchor}, seed "${seed}")\n`);
        plan.forEach((inv, i) => console.log(reportLine(inv, i, fileNameFor(inv, seed))));
        console.log('\nPer supplier:');
        for (const [k, v] of Object.entries(byS).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
        console.log(`\nMonths covered: ${months.join(', ')}`);
        return;
    }

    fs.mkdirSync(outDir, { recursive: true });
    const made = [];
    for (const inv of plan) {
        const name = fileNameFor(inv, seed);
        const p = path.join(outDir, name);
        await renderPdf(inv, p);
        made.push({ name, path: p, inv });
    }
    console.log(`Rendered ${made.length} PDFs into ${outDir}`);

    if (flag('upload')) {
        const cfg = {
            url: arg('nc-url', process.env.NC_URL || 'http://localhost:8081'),
            user: arg('nc-user', process.env.NC_USER || 'admin'),
            pass: arg('nc-pass', process.env.NC_PASS || 'admin'),
            folder: arg('nc-folder', process.env.NC_FOLDER || 'Invoices'),
        };
        await ensureFolder(cfg);
        let ok = 0;
        for (const m of made) {
            await uploadFile(cfg, m.name, m.path);
            ok += 1;
        }
        console.log(`Uploaded ${ok}/${made.length} to ${cfg.url}/remote.php/dav/files/${cfg.user}/${cfg.folder}`);
    }

    // Ground truth for benchmarking an extractor against these documents:
    // every field, exactly as the PDF states it, keyed by filename.
    const manifestPath = arg('manifest', null);
    if (manifestPath) {
        const manifest = made.map(m => ({
            file: m.name,
            supplier: m.inv.supplier.name,
            invoiceNumber: m.inv.number,
            invoiceDate: `${m.inv.date.getUTCFullYear()}-${String(m.inv.date.getUTCMonth() + 1).padStart(2, '0')}-${String(m.inv.date.getUTCDate()).padStart(2, '0')}`,
            dueDate: `${m.inv.due.getUTCFullYear()}-${String(m.inv.due.getUTCMonth() + 1).padStart(2, '0')}-${String(m.inv.due.getUTCDate()).padStart(2, '0')}`,
            currency: m.inv.supplier.currency,
            net: m.inv.subtotal,
            vat: m.inv.vat,
            vatRate: m.inv.supplier.vatRate,
            total: m.inv.total,
            lineItemCount: m.inv.items.length,
            layout: m.inv.supplier.layout,
            language: m.inv.supplier.lang,
        }));
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
        console.log(`Ground-truth manifest written to ${manifestPath}`);
    }

    console.log('\nSummary:');
    made.forEach((m, i) => console.log(reportLine(m.inv, i, m.name)));
    console.log('\nPer supplier:');
    for (const [k, v] of Object.entries(byS).sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
    console.log(`\nMonths covered: ${months.join(', ')}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
