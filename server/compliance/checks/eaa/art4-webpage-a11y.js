/**
 * EAA Art. 4 / Annex I §III–IV (EN 301 549 V3.2.1 §9 = WCAG 2.1 AA; V4.1.1 = WCAG 2.2 AA, not yet cited) — published pages
 * pass the static accessibility lint.
 *
 * Per-source over the pages the organisation itself publishes to the world:
 *   • AI webpages — `webpages.is_published` rows of the org; the HTML is the
 *     pinned published snapshot (`readSlot(owner, id, 'html',
 *     published_version_id)`), exactly what /share/<token> serves. A body-only
 *     slot is wrapped the way the viewer wraps it (a bare <html> without lang),
 *     so a fragment that never declares a language fails html-lang honestly.
 *     react-mui pages keep their app in extra files and compile client-side —
 *     nothing static to lint → not_applicable, pointing at the CI artefact.
 *   • CMS pages — the platform marketing site (`cms_published_<siteId>`),
 *     rendered with core/seo/renderBlocks and spliced into the SAME shell the
 *     public renderer uses (core/seo/shell + inject + head — imported, not
 *     copied). The CMS is platform-wide, not per org, so its pages are
 *     subjects only on a self-hosted deployment where operator == org; on Bee
 *     Flow Cloud they are Bee Flow's own pages, not the tenant's.
 *
 * Lint = compliance/a11y/htmlLint.js (cheerio). Error-class finding → fail,
 * warnings only → warn, clean → pass. Subjects are capped at 200 — the cap is
 * reported in listSubjects' extras so the UI can say "first 200 of n".
 *
 * Out of scope, by design (stated in the description): colour contrast, focus
 * visibility, keyboard operability, reflow, dynamic ARIA, motion — those need
 * a rendered DOM and axe, which is EAA-Art4-product-surfaces-conformance.
 *
 * Evidence: per-rule counts, ≤ 10 sample snippets per rule (page content,
 * e-mail addresses scrubbed by the lint), html_sha256, lint_version. Page
 * names and ids only — never the author's identity.
 */

const crypto = require('crypto');
const { getAll } = require('../../../db');
const complianceStore = require('../../../stores/complianceStore');
const htmlLint = require('../../a11y/htmlLint');

const SUBJECT_CAP = 200;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const NOT_PROVISIONED = new Set(['42P01', '42703']);

function _notRelevant(settings) {
    let rel = settings && settings.framework_relevance;
    if (typeof rel === 'string') { try { rel = JSON.parse(rel); } catch { rel = null; } }
    return !!rel && rel.eaa === 'not_relevant';
}

function _deploymentMode() {
    try { return require('../../../license').deploymentMode(); } catch { return process.env.DEPLOYMENT_MODE || 'cloud'; }
}

function _parseSettingsJson(v) {
    if (!v) return {};
    if (typeof v === 'object') return v;
    try { return JSON.parse(v) || {}; } catch { return {}; }
}

function _sha256(s) { return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex'); }

/** The viewer's own wrap for a body-only html slot (composeWebpageDocument fallback). */
function _wrapFragment(html) {
    return `<!DOCTYPE html><html><head></head><body>${html}</body></html>`;
}

/** A minimal SPA-shaped shell for when agent-hub's index.html is unreachable (tests, cold start). */
const FALLBACK_SHELL = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div></body></html>';

// ── subjects ───────────────────────────────────────────────────────────

async function _webpageSubjects(orgId, limit) {
    let rows;
    try {
        rows = await getAll(
            `SELECT id, name, user_id, published_version_id, settings, updated_at
               FROM webpages
              WHERE organization_id = $1 AND is_published = TRUE
              ORDER BY updated_at DESC
              LIMIT $2`,
            [orgId, limit + 1]
        );
    } catch (e) {
        if (NOT_PROVISIONED.has(e?.code)) return { subjects: [], total: 0, skipped: 'webpages not provisioned' };
        throw e;
    }
    const subjects = rows.slice(0, limit).map(r => {
        const settings = _parseSettingsJson(r.settings);
        return {
            id: `webpage:${r.id}`,
            label: r.name || r.id,
            name: r.name || r.id,
            kind: 'webpage',
            webpage_id: r.id,
            owner_id: r.user_id,
            published_version_id: r.published_version_id || null,
            framework: typeof settings.framework === 'string' ? settings.framework : null,
        };
    });
    return { subjects, total: rows.length, skipped: null };
}

async function _cmsSubjects(limit) {
    if (limit <= 0) return { subjects: [], total: 0, skipped: 'cap reached' };
    if (_deploymentMode() === 'cloud') return { subjects: [], total: 0, skipped: 'cms is platform-owned on cloud' };
    let cmsStore;
    try { cmsStore = require('../../../stores/cmsStore'); } catch { return { subjects: [], total: 0, skipped: 'cms store unavailable' }; }
    let projects = [];
    try { projects = await cmsStore.listProjects(); } catch { return { subjects: [], total: 0, skipped: 'cms index unreadable' }; }
    const site = projects[0];
    if (!site) return { subjects: [], total: 0, skipped: null };
    let snap = null;
    try { snap = await cmsStore.getPublishedSnapshot(site.id); } catch { snap = null; }
    const pages = Array.isArray(snap?.site?.pages) ? snap.site.pages : [];
    const subjects = pages.slice(0, limit).map(p => ({
        id: `cms:${site.id}:${p.id}`,
        label: p.title || p.slug || p.id,
        name: p.title || p.slug || p.id,
        kind: 'cms',
        site_id: site.id,
        page_id: p.id,
        slug: p.isHomepage ? '' : (p.slug || ''),
    }));
    return { subjects, total: pages.length, skipped: null };
}

// ── html sources ───────────────────────────────────────────────────────

async function _webpageHtml(subject) {
    const storage = require('../../../stores/webpage/storage');
    const html = await storage.readSlot(subject.owner_id, subject.webpage_id, 'html', subject.published_version_id || null);
    return typeof html === 'string' ? html : '';
}

async function _cmsHtml(subject, settings) {
    const cmsStore = require('../../../stores/cmsStore');
    const { renderBlocks, PREHYDRATE_CSS } = require('../../../core/seo/renderBlocks');
    const { buildHead } = require('../../../core/seo/head');
    const { injectIntoShell } = require('../../../core/seo/inject');
    const { getShell } = require('../../../core/seo/shell');

    const defaultLocale = await cmsStore.getDefaultLocale();
    const eff = await cmsStore.getEffectivePublished(subject.site_id, subject.slug, defaultLocale);
    if (!eff || !eff.found || !eff.page) return { html: null, reason: 'page not in the published snapshot' };

    const origin = (settings?.public_base_url || process.env.PUBLIC_SITE_URL || process.env.PUBLIC_BASE_URL || 'https://localhost').replace(/\/+$/, '');
    const siteName = (eff.header && eff.header.logoText) || 'Bee Flow';
    const head = buildHead({
        origin, slug: subject.slug, locale: defaultLocale, defaultLocale, locales: [defaultLocale],
        page: eff.page, design: eff.design || {}, siteName,
    });
    const body = renderBlocks(eff.page.blocks, { fallbackTitle: eff.page.title });
    const shell = (await getShell()) || FALLBACK_SHELL;
    const headWithCss = body ? `${head}\n<style>${PREHYDRATE_CSS}</style>` : head;
    return { html: injectIntoShell(shell, { head: headWithCss, body, lang: defaultLocale }), reason: null, lang: defaultLocale };
}

// ── verdict ────────────────────────────────────────────────────────────

function _verdict(report, subject, extra) {
    const errorCount = report.errors.reduce((n, r) => n + r.count, 0);
    const warnCount = report.warnings.reduce((n, r) => n + r.count, 0);
    const evidence = {
        subject_id: subject.id,
        kind: subject.kind,
        errors: report.errors.map(r => ({ rule: r.rule, wcag: r.wcag, count: r.count, samples: r.samples.slice(0, 10) })),
        warnings: report.warnings.map(r => ({ rule: r.rule, wcag: r.wcag, count: r.count, samples: r.samples.slice(0, 10) })),
        rules_checked: report.rules_checked,
        rules_skipped: report.rules_skipped || [],
        lang: report.lang || null,
        lint_version: report.version,
        ...extra,
    };
    const names = list => list.map(r => `${r.rule} ×${r.count}`).join(', ');
    if (errorCount > 0) {
        return {
            status: 'fail',
            evidence,
            details: `${errorCount} error-class finding(s) on "${subject.label}": ${names(report.errors)}${warnCount ? ` (+${warnCount} warning(s))` : ''}. Fix them in the page and republish.`,
        };
    }
    if (warnCount > 0) {
        return {
            status: 'warn',
            evidence,
            details: `No blocking findings on "${subject.label}", but ${warnCount} warning(s): ${names(report.warnings)}.`,
        };
    }
    return {
        status: 'pass',
        evidence,
        details: `"${subject.label}" passes the static lint (${report.rules_checked.length} rules). Contrast and keyboard behaviour are covered by the CI conformance check, not here.`,
    };
}

module.exports = {
    id: 'EAA-Art4-webpage-a11y',
    regulation: 'EAA',
    article: 'Art. 4',
    frameworks: [],
    severity: 'high',
    scope: 'per-source',
    verification: 'automated',
    titleKey: 'compliance.check_eaa_webpage_a11y_title',
    descriptionKey: 'compliance.check_eaa_webpage_a11y_desc',
    remediationKey: 'compliance.check_eaa_webpage_a11y_fix',
    remediationLink: 'admin/studio/webpages',
    SUBJECT_CAP,

    async listSubjects(orgId) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) return [];
        const pages = await _webpageSubjects(orgId, SUBJECT_CAP);
        const cms = await _cmsSubjects(SUBJECT_CAP - pages.subjects.length);
        const all = [...pages.subjects, ...cms.subjects];
        const total = pages.total + cms.total;
        if (total > SUBJECT_CAP) for (const s of all) { s.capped = true; s.total_published = total; }
        return all;
    },

    async evaluate(orgId, subject) {
        const settings = await complianceStore.getSettings(orgId);
        if (_notRelevant(settings)) {
            return {
                status: 'not_applicable',
                evidence: { relevance: 'not_relevant' },
                details: 'The EAA was marked not relevant for this organisation (Compliance → Frameworks).',
            };
        }
        if (!subject?.id) {
            return { status: 'not_applicable', evidence: { subjects: 0 }, details: 'No published pages to lint.' };
        }

        let html = null;
        let lang = null;
        const extra = { subject_label: subject.label };
        try {
            if (subject.kind === 'cms') {
                const r = await _cmsHtml(subject, settings);
                if (!r.html) {
                    return { status: 'warn', evidence: { ...extra, subject_id: subject.id, kind: 'cms', reason: r.reason }, details: `CMS page "${subject.label}" could not be rendered from the published snapshot (${r.reason}).` };
                }
                html = r.html;
                lang = r.lang;
                extra.site_id = subject.site_id;
                extra.page_id = subject.page_id;
            } else {
                html = await _webpageHtml(subject);
                extra.webpage_id = subject.webpage_id;
                extra.published_version_id = subject.published_version_id || null;
                extra.framework = subject.framework || null;
                if (!html.trim()) {
                    if (subject.framework === 'react-mui') {
                        return {
                            status: 'not_applicable',
                            evidence: { ...extra, subject_id: subject.id, kind: 'webpage', reason: 'client_rendered' },
                            details: `"${subject.label}" is a react-mui page: its markup is compiled in the browser, so there is nothing static to lint. Rendered surfaces are covered by the CI conformance check.`,
                        };
                    }
                    return {
                        status: 'warn',
                        evidence: { ...extra, subject_id: subject.id, kind: 'webpage', reason: 'empty_html' },
                        details: `"${subject.label}" is published but its html slot is empty (storage unavailable or nothing written) — nothing to lint.`,
                    };
                }
                if (!/<html[\s>]/i.test(html)) html = _wrapFragment(html);
            }
        } catch (e) {
            if (NOT_PROVISIONED.has(e?.code)) {
                return { status: 'warn', evidence: { ...extra, subject_id: subject.id, reason: 'not provisioned yet' }, details: 'not provisioned yet' };
            }
            return {
                status: 'warn',
                evidence: { ...extra, subject_id: subject.id, reason: 'read_failed', error: String(e?.message || e).slice(0, 160) },
                details: `Could not read the published HTML of "${subject.label}" — ${String(e?.message || e).slice(0, 160)}`,
            };
        }

        if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
            return {
                status: 'warn',
                evidence: { ...extra, subject_id: subject.id, reason: 'too_large', bytes: Buffer.byteLength(html, 'utf8') },
                details: `"${subject.label}" is larger than ${MAX_HTML_BYTES} bytes — skipped by the static lint.`,
            };
        }
        const report = htmlLint.lint(html, { lang });
        return _verdict(report, subject, { ...extra, html_sha256: _sha256(html), html_bytes: Buffer.byteLength(html, 'utf8') });
    },
};
