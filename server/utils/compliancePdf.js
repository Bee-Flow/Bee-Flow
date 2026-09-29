// @typecheck
/**
 * Compliance PDF builders — auditor-facing documents rendered server-side with
 * pdfkit (English; the canonical compliance language of the defaults catalog).
 *
 * Tamper evidence: every document footer prints the SHA-256 of the *source
 * data* used to render it. The same hash is written to the compliance_evidence
 * chain by the route, so a printed report can be matched byte-for-byte against
 * the immutable record it came from.
 *
 * Exports (JSON + PDF only — project rule: no CSV):
 *   buildComplianceReport({ orgName, generatedAt, overall, gdpr, aia, iso, verificationSummary, rows })
 *   buildRopaPdf(ropa)
 *   buildDpiaPdf({ agentName, dpia })
 *   buildSoaPdf({ orgName, generatedAt, rows, stats })           — landscape 93-row SoA
 *   buildClauseConformityPdf({ orgName, generatedAt, clauses })  — Stage-1 clause 4–10 pack
 * All return Promise<{ buffer, hash }>.
 */

const crypto = require('crypto');

// The document factory, chunk collector, measured table and per-page footer
// now live in utils/pdfKit.js so the repo's other pdfkit documents can use
// them. They were born here; moving them out is the whole reason the demo
// generator stopped shipping blank pages.
const { INK, MUTED, LINE, newDoc: _newDoc, collect: _collect, table: _table, footer: _footer } = require('./pdfKit');
const STATUS_COLOR = { pass: '#059669', warn: '#d97706', fail: '#dc2626', not_applicable: '#64748b', pending: '#64748b' };

function hashData(data) {
    return crypto.createHash('sha256').update(JSON.stringify(data || {})).digest('hex');
}

/** Date / name / signature lines — the auditor-facing sign-off block. */
function _signatureBlock(doc, { role = 'Approved by (management)' } = {}) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 110) doc.addPage();
    doc.moveDown(1.2);
    doc.fontSize(9).font('Helvetica-Bold').fillColor(INK).text(role);
    doc.moveDown(1.6);
    const y = doc.y;
    const left = doc.page.margins.left;
    const colW = 150;
    for (const [i, label] of ['Name', 'Date', 'Signature'].entries()) {
        const x = left + i * (colW + 24);
        doc.moveTo(x, y).lineTo(x + colW, y).strokeColor(INK).lineWidth(0.7).stroke();
        doc.fontSize(7.5).font('Helvetica').fillColor(MUTED).text(label, x, y + 3, { width: colW });
    }
    doc.y = y + 26;
    doc.x = left;
}

/** Footer on every page: integrity hash + disclaimer + page number. */
function _finalize(doc, dataHash) {
    _footer(doc, `Integrity sha256:${dataHash} — this document supports, but does not replace, legal review.`);
}

function _header(doc, title, orgName, generatedAt) {
    doc.fillColor(INK).fontSize(18).font('Helvetica-Bold').text(title);
    doc.moveDown(0.2);
    doc.fontSize(10).font('Helvetica').fillColor(MUTED)
        .text(`${orgName || 'Organisation'} — generated ${new Date(generatedAt || Date.now()).toISOString()}`);
    doc.moveDown(0.4);
    doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y)
        .strokeColor(LINE).lineWidth(1).stroke();
    doc.moveDown(0.8);
}

function _sectionTitle(doc, text) {
    if (doc.y > doc.page.height - doc.page.margins.bottom - 80) doc.addPage();
    doc.moveDown(0.4);
    doc.fontSize(12).font('Helvetica-Bold').fillColor(INK).text(text);
    doc.moveDown(0.3);
}

function _kv(doc, key, value) {
    doc.fontSize(9.5).font('Helvetica-Bold').fillColor(MUTED).text(key.toUpperCase(), { continued: true });
    doc.font('Helvetica').fillColor(INK).text(`   ${value ?? '—'}`);
}


// ─────────────────────────── Compliance report ───────────────────────────

async function buildComplianceReport(data) {
    const dataHash = hashData(data);
    const doc = _newDoc();
    const done = _collect(doc);

    _header(doc, 'Compliance Report — GDPR, EU AI Act & ISO 27001', data.orgName, data.generatedAt);

    _sectionTitle(doc, 'Scores');
    _kv(doc, 'Overall', `${data.overall?.score ?? '—'} / 100   (${data.overall?.pass ?? 0} pass · ${data.overall?.warn ?? 0} warn · ${data.overall?.fail ?? 0} fail · ${data.overall?.na ?? 0} n/a)`);
    _kv(doc, 'GDPR', `${data.gdpr?.score ?? '—'} / 100`);
    _kv(doc, 'EU AI Act', `${data.aia?.score ?? '—'} / 100`);
    if (data.iso && data.iso.total > 0) _kv(doc, 'ISO 27001 (automated controls)', `${data.iso.score ?? '—'} / 100`);
    const vs = data.verificationSummary || {};
    const auto = (vs.automated?.total || 0) + (vs.hybrid?.total || 0);
    const autoPass = (vs.automated?.pass || 0) + (vs.hybrid?.pass || 0);
    _kv(doc, 'Verified automatically', `${autoPass}/${auto} passing`);
    _kv(doc, 'Self-attested', `${vs.attestation?.pass || 0}/${vs.attestation?.total || 0} in place`);
    doc.moveDown(0.3);
    doc.fontSize(8.5).fillColor(MUTED).text(
        'Automated checks reflect live system state and telemetry; self-attested items reflect administrator declarations that the tool cannot verify independently.');

    const REG_LABEL = { GDPR: 'GDPR checks', AIA: 'EU AI Act checks', ISO27001: 'ISO 27001 checks' };
    for (const regulation of ['GDPR', 'AIA', 'ISO27001']) {
        const rows = (data.rows || []).filter(r => r.regulation === regulation);
        if (!rows.length) continue;
        _sectionTitle(doc, REG_LABEL[regulation]);
        for (const r of rows) {
            if (doc.y > doc.page.height - doc.page.margins.bottom - 70) doc.addPage();
            const color = STATUS_COLOR[r.status] || MUTED;
            doc.fontSize(10).font('Helvetica-Bold').fillColor(color)
                .text(String(r.status || 'pending').toUpperCase(), { continued: true, width: 480 });
            doc.fillColor(INK).text(`  ${r.title}`, { continued: true });
            doc.font('Helvetica').fillColor(MUTED).fontSize(8.5)
                .text(`   Art. ${r.article} · ${r.severity} · ${r.verification}${r.scope_id ? ` · ${r.scope_id}` : ''}`);
            if (r.details) {
                doc.fontSize(8.5).fillColor(INK).text(r.details, { indent: 12 });
            }
            if (r.evidence_hash) {
                doc.fontSize(7.5).fillColor(MUTED).text(`evidence sha256:${r.evidence_hash}`, { indent: 12 });
            }
            doc.moveDown(0.35);
        }
    }

    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

// ─────────────────────────── ROPA ───────────────────────────

async function buildRopaPdf(ropa) {
    const dataHash = hashData(ropa);
    const doc = _newDoc();
    const done = _collect(doc);

    _header(doc, 'Records of Processing Activities (GDPR Art. 30)', ropa.controller?.name, ropa.generated_at);

    _sectionTitle(doc, 'Controller');
    _kv(doc, 'Organisation', ropa.controller?.name);
    _kv(doc, 'DPO', [ropa.controller?.dpo_name, ropa.controller?.dpo_email, ropa.controller?.dpo_phone].filter(Boolean).join(' · ') || '—');
    _kv(doc, 'Legal bases', (ropa.legal_bases || []).join(', ') || '—');
    _kv(doc, 'Data residency', ropa.data_residency);
    _kv(doc, 'Last reviewed', ropa.last_reviewed_at
        ? `${new Date(ropa.last_reviewed_at).toISOString()}${ropa.last_reviewed_by ? ` by ${ropa.last_reviewed_by}` : ''}`
        : 'never');

    _sectionTitle(doc, `Processing activities (${(ropa.activities || []).length})`);
    for (const a of ropa.activities || []) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 110) doc.addPage();
        doc.fontSize(10.5).font('Helvetica-Bold').fillColor(INK).text(a.name);
        doc.fontSize(8.5).font('Helvetica');
        _kv(doc, 'Purpose', a.purpose);
        _kv(doc, 'Data categories', (a.data_categories || []).join(', '));
        _kv(doc, 'Data subjects', (a.data_subjects || []).join(', '));
        _kv(doc, 'Retention', a.retention);
        _kv(doc, 'Third-country transfers', (a.transfers || []).length ? a.transfers.join(', ') : 'none');
        _kv(doc, 'Security measures', (a.security_measures || []).join('; '));
        doc.moveDown(0.5);
    }

    const sccSet = new Set((ropa.scc_confirmed_operators || [])
        .map(o => String(o?.operator || o || '').toLowerCase()).filter(Boolean));
    _sectionTitle(doc, `Processors — observed outbound operators (${(ropa.processors || []).length})`);
    for (const p of ropa.processors || []) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 60) doc.addPage();
        // Via a global network only (no located traffic outside Europe): the
        // final location is not visible, so the line says that instead of
        // claiming EU or a transfer.
        const viaNetworkOnly = Number(p.via_network_calls) > 0 && !(Number(p.outside_calls) > 0);
        const attested = sccSet.has(String(p.operator || '').toLowerCase());
        const scc = p.is_eu && !(Number(p.outside_calls) > 0) ? 'EU — SCC not required'
            : viaNetworkOnly ? `via a global network, final location not visible · ${attested ? 'SCC attested' : 'SCC not attested'}`
                : attested ? 'SCC attested' : 'SCC NOT attested';
        doc.fontSize(9.5).font('Helvetica-Bold').fillColor(INK).text(p.operator || 'unknown', { continued: true });
        doc.font('Helvetica').fillColor(MUTED)
            .text(`   ${p.country_name || p.country_code || '—'} · ${p.calls} call(s) · last seen ${p.last_seen ? new Date(p.last_seen).toISOString().slice(0, 10) : '—'} · ${scc}`);
    }

    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

// ─────────────────────────── DPIA ───────────────────────────

async function buildDpiaPdf({ agentName, dpia }) {
    const dataHash = hashData({ agentName, dpia });
    const doc = _newDoc();
    const done = _collect(doc);

    _header(doc, 'Data Protection Impact Assessment (GDPR Art. 35)', agentName, dpia?.created_at);

    _sectionTitle(doc, 'Assessment');
    _kv(doc, 'Agent', agentName);
    _kv(doc, 'Mode', dpia?.mode);
    _kv(doc, 'Residual risk', dpia?.risk_level);
    _kv(doc, 'Approved by', dpia?.approved_by);
    _kv(doc, 'Approved at', dpia?.approved_at ? new Date(dpia.approved_at).toISOString() : '—');
    _kv(doc, 'Valid until', dpia?.expires_at ? new Date(dpia.expires_at).toISOString() : 'no expiry');

    const answers = dpia?.answers && typeof dpia.answers === 'object' ? dpia.answers : {};
    if (Object.keys(answers).length) {
        _sectionTitle(doc, 'Questionnaire');
        for (const [k, v] of Object.entries(answers)) {
            _kv(doc, k.replace(/_/g, ' '), typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v ?? '—'));
        }
    }
    const mitigations = Array.isArray(dpia?.mitigations) ? dpia.mitigations : [];
    if (mitigations.length) {
        _sectionTitle(doc, 'Mitigations');
        for (const m of mitigations) doc.fontSize(9.5).font('Helvetica').fillColor(INK).text(`• ${m}`);
    }

    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

// ─────────────────────────── ISO 27001 — SoA ───────────────────────────
//
// The SoA PDF is a RENDER of the row store — the decision trail lives in
// iso_soa_entries + the evidence chain, never in this document.

async function buildSoaPdf({ orgName, generatedAt, rows, stats }) {
    const dataHash = hashData({ orgName, rows, stats });
    const doc = _newDoc({ landscape: true });
    const done = _collect(doc);

    _header(doc, 'Statement of Applicability — ISO/IEC 27001:2022 Annex A', orgName, generatedAt);
    _kv(doc, 'Rows', `${rows.length} controls · ${stats?.approved ?? 0} approved · ${stats?.reviewed ?? 0} reviewed · ${stats?.todo ?? 0} to review · ${stats?.excluded ?? 0} excluded`);
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor(MUTED).text(
        'Sources: "auto" = continuously verified from system state; "connector" = verified via a coupled external system; '
        + '"attest" = administrator declaration; "inherited" = provided by the infrastructure provider. '
        + 'Control references and titles are identifiers from ISO/IEC 27001:2022 Annex A (iso.org); all decision text is the organisation\'s own.');
    doc.moveDown(0.6);

    const SRC_COLOR = { auto: '#059669', connector: '#4f46e5', attest: '#d97706', inherited: '#64748b' };
    _table(doc, {
        columns: [
            { key: 'ref', label: 'Ref', width: 40, bold: true },
            { key: 'title', label: 'Control', width: 130 },
            { key: 'applicable', label: 'Applicable', width: 48, color: r => (r.applicable === 'no' ? '#dc2626' : INK) },
            { key: 'source', label: 'Source', width: 52, color: r => SRC_COLOR[r.source] || INK },
            { key: 'status', label: 'Decision', width: 52, color: r => (r.status === 'approved' ? '#059669' : r.status === 'reviewed' ? '#0369a1' : '#d97706') },
            { key: 'check', label: 'Live check', width: 80 },
            { key: 'owner', label: 'Owner', width: 78 },
            { key: 'justification', label: 'Justification', width: 220 },
        ],
        rows,
    });

    _signatureBlock(doc, { role: 'Statement of Applicability approved by' });
    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

// ──────────────── ISO 27001 — clause 4–10 conformity pack ────────────────
//
// The Stage-1 deliverable: per management-system clause, what the tool can
// SHOW exists today — and an honest 'not recorded' where it cannot. Statuses:
// in_place | partial | not_recorded.

async function buildClauseConformityPdf({ orgName, generatedAt, clauses }) {
    const dataHash = hashData({ orgName, clauses });
    const doc = _newDoc();
    const done = _collect(doc);

    _header(doc, 'ISMS Clause Conformity Statement — ISO/IEC 27001:2022', orgName, generatedAt);
    doc.fontSize(8.5).fillColor(MUTED).text(
        'This statement lists, per management-system clause (4–10), the artefacts and records this organisation can '
        + 'produce from its compliance tooling, with an explicit "not recorded" where no artefact exists yet. '
        + 'It supports — but does not replace — your ISMS, your internal auditor, and your certification body.');
    doc.moveDown(0.8);

    const ST = {
        in_place: { label: 'IN PLACE', color: '#059669' },
        partial: { label: 'PARTIAL', color: '#d97706' },
        not_recorded: { label: 'NOT RECORDED', color: '#dc2626' },
    };
    for (const c of clauses || []) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 90) doc.addPage();
        const st = ST[c.status] || ST.not_recorded;
        doc.fontSize(11).font('Helvetica-Bold').fillColor(INK)
            .text(`Clause ${c.clause} — ${c.title}`, { continued: true });
        doc.fontSize(9).fillColor(st.color).text(`   ${st.label}`);
        for (const e of c.evidence || []) {
            doc.fontSize(8.5).font('Helvetica').fillColor(INK).text(`• ${e}`, { indent: 12 });
        }
        if (c.gap) {
            doc.fontSize(8.5).font('Helvetica').fillColor(MUTED).text(`Gap: ${c.gap}`, { indent: 12 });
        }
        doc.moveDown(0.5);
    }

    _signatureBlock(doc, { role: 'Reviewed by (ISMS lead)' });
    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

// ─────────────────────────── ISO 27001 — risk register ───────────────────────────

async function buildRiskRegisterPdf({ orgName, generatedAt, rows, stats }) {
    const dataHash = hashData({ orgName, rows, stats });
    const doc = _newDoc({ landscape: true });
    const done = _collect(doc);

    _header(doc, 'Risk Register — ISO/IEC 27001:2022 clause 6.1', orgName, generatedAt);
    _kv(doc, 'Risks', `${rows.length} total · ${stats?.open ?? 0} open · ${stats?.high ?? 0} high (score ≥ 10) · ${stats?.accepted ?? 0} accepted · ${stats?.closed ?? 0} closed`);
    doc.moveDown(0.3);
    doc.fontSize(8).fillColor(MUTED).text(
        'Score = likelihood (1–5) × impact (1–5). Acceptance is a recorded human decision (who + when); the tool never accepts a risk by itself.');
    doc.moveDown(0.6);

    const bandColor = (score) => (score >= 16 ? '#dc2626' : score >= 10 ? '#ea580c' : score >= 5 ? '#d97706' : '#059669');
    _table(doc, {
        columns: [
            { key: 'title', label: 'Risk', width: 170, bold: true },
            { key: 'category', label: 'Category', width: 70 },
            { key: 'score', label: 'L×I', width: 40, color: r => bandColor(Number(r.score_num) || 0) },
            { key: 'status', label: 'Status', width: 55 },
            { key: 'owner', label: 'Owner', width: 80 },
            { key: 'treatments', label: 'Treatment(s)', width: 210 },
            { key: 'accepted', label: 'Accepted', width: 90 },
        ],
        rows,
    });

    _signatureBlock(doc, { role: 'Risk register reviewed by' });
    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

// ─────────────────────────── ISO 27001 — policy pack ───────────────────────────
//
// Renders the PUBLISHED version of every ISMS document with a minimal markdown
// treatment (headings, bullets — pdfkit renders text, not HTML; good enough for
// an auditor pack, and each document's sha256 pins it to the acknowledged
// version).

function _renderMarkdown(doc, body) {
    for (const rawLine of String(body || '').split('\n')) {
        const line = rawLine.trimEnd();
        if (doc.y > doc.page.height - doc.page.margins.bottom - 40) doc.addPage();
        if (/^#\s+/.test(line)) {
            doc.moveDown(0.3);
            doc.fontSize(13).font('Helvetica-Bold').fillColor(INK).text(line.replace(/^#\s+/, ''));
            doc.moveDown(0.2);
        } else if (/^##\s+/.test(line)) {
            doc.moveDown(0.25);
            doc.fontSize(11).font('Helvetica-Bold').fillColor(INK).text(line.replace(/^##\s+/, ''));
            doc.moveDown(0.15);
        } else if (/^###\s+/.test(line)) {
            doc.fontSize(10).font('Helvetica-Bold').fillColor(INK).text(line.replace(/^###\s+/, ''));
        } else if (/^\s*[-*]\s+/.test(line)) {
            doc.fontSize(9).font('Helvetica').fillColor(INK)
                .text(`•  ${line.replace(/^\s*[-*]\s+/, '').replace(/\*\*/g, '')}`, { indent: 12 });
        } else if (line.trim() === '') {
            doc.moveDown(0.25);
        } else {
            doc.fontSize(9).font('Helvetica').fillColor(INK).text(line.replace(/\*\*/g, ''));
        }
    }
}

async function buildPolicyPackPdf({ orgName, generatedAt, documents }) {
    const dataHash = hashData({ orgName, documents: documents.map(d => ({ slug: d.slug, version: d.version, sha256: d.sha256 })) });
    const doc = _newDoc();
    const done = _collect(doc);

    _header(doc, 'ISMS Policy Pack — controlled documents', orgName, generatedAt);
    _sectionTitle(doc, 'Contents');
    for (const d of documents) {
        doc.fontSize(9).font('Helvetica').fillColor(INK)
            .text(`${d.title}  —  v${d.version} · published ${d.published_at ? new Date(d.published_at).toISOString().slice(0, 10) : '—'}`);
        doc.fontSize(7).fillColor(MUTED).text(`sha256:${d.sha256}`, { indent: 12 });
    }

    for (const d of documents) {
        doc.addPage();
        doc.fontSize(15).font('Helvetica-Bold').fillColor(INK).text(d.title);
        doc.fontSize(8).font('Helvetica').fillColor(MUTED)
            .text(`Version ${d.version} · sha256:${d.sha256}`);
        doc.moveDown(0.6);
        _renderMarkdown(doc, d.body);
    }

    _finalize(doc, dataHash);
    return { buffer: await done, hash: dataHash };
}

module.exports = { buildComplianceReport, buildRopaPdf, buildDpiaPdf, buildSoaPdf, buildClauseConformityPdf, buildRiskRegisterPdf, buildPolicyPackPdf, hashData };
