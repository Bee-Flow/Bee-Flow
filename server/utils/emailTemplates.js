// @typecheck
const appPaths = require('./appPaths');

/**
 * Shared branded shell. Most lifecycle emails share the same chrome
 * (logo header, title, body, CTA, footer); this composer builds the HTML
 * and plaintext so individual templates only specify the copy.
 *
 * `intro`, `body` and `footer` are MARKUP fragments — callers style them with
 * <strong>, <br>, tables — so the shell passes them through with raw(). That
 * makes escaping the caller's job, and the way to do it is to build the fragment
 * with safeHtml`...` so its own interpolations are escaped while its markup is
 * not. `title` and `ctaLabel`/`ctaUrl` are plain values and the shell escapes
 * them itself.
 *
 * @param {{ title: string, intro?: string, body: string, ctaLabel?: string, ctaUrl?: string, footer?: string }} parts
 */
function _renderEmailShell({ title, intro, body, ctaLabel, ctaUrl, footer }) {
    const clientHost = appPaths.clientHost();
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;
    const cta = (ctaLabel && ctaUrl)
        ? safeHtml`
        <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${ctaUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                ${ctaLabel}
              </a>
            </td></tr>
        </table>`
        : '';
    const html = safeHtml`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">${title}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px 36px;">
          ${raw(intro ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">${intro}</p>` : '')}
          ${raw(`<div style="margin:0 0 24px;font-size:15px;line-height:1.65;color:#334155;">${body}</div>`)}
          ${raw(cta)}
          ${raw(footer ? `<p style="margin:24px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">${footer}</p>` : '')}
        </td></tr>
        <tr><td style="padding:20px 40px;text-align:center;background:#fafafa;border-top:1px solid #f0f0f0;">
          <p style="margin:0;font-size:11px;color:#94a3b8;">
            Sent by BeeFlow · <a href="${clientHost}" style="color:#6b7280;text-decoration:none;">${process.env.CLIENT_PUBLIC_HOST || 'beeflow.nl'}</a>
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();
    return html;
}

function _escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Tagged template that HTML-escapes every interpolated value.
 *
 * The hand-written senders below build their bodies with plain template
 * literals, so `${orgName}`, `${displayName}` and friends landed in an HTML
 * document verbatim. `_escapeHtml` existed the whole time but was wired into
 * exactly one place — the configurable-template renderer — so every hand-written
 * mail was unescaped. A pentest stored `<img src=x onerror=...>` in an
 * organisation's name and concluded it was inert because React escapes on
 * render; React never sees these. A mail client does, and `orgName` is writable
 * through unauthenticated signup.
 *
 * Escaping thirteen templates by hand invites missing the fourteenth, so the
 * default is inverted instead: use html`...` and interpolation is safe unless
 * you wrap the value in raw().
 *
 *   safeHtml`<p>Hi ${displayName}</p>`          // escaped
 *   safeHtml`<p>${raw(alreadyBuiltMarkup)}</p>` // deliberate, and it says so
 */
const RAW = Symbol('raw-html');

const raw = (value) => ({ [RAW]: String(value == null ? '' : value) });

function safeHtml(strings, ...values) {
    let out = strings[0];
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        out += (v && typeof v === 'object' && RAW in v) ? v[RAW] : _escapeHtml(v);
        out += strings[i + 1];
    }
    return out;
}

/** Replace {{var}} tokens with raw values from `vars` (unknown tokens → ''). */
function _substituteVars(str, vars = {}) {
    return String(str == null ? '' : str).replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key] ?? '') : ''
    );
}

/** Render a plain-text template field to safe HTML (substitute → escape → <br>). */
function _renderField(str, vars, { multiline = false } = {}) {
    const escaped = _escapeHtml(_substituteVars(str, vars));
    return multiline ? escaped.replace(/\n/g, '<br>') : escaped;
}

/**
 * The substitution values of a template, e.g. { name, orgName, verifyUrl } or { name, orgName, loginUrl }.
 * @typedef {Record<string, string | null | undefined>} EmailVars
 */

/**
 * Build {subject, html, text} from an already-resolved template object
 * ({subject,title,intro,body,ctaLabel}) and substitution vars. Used by the
 * send functions and by the admin live-preview endpoint (which passes
 * in-progress, unsaved fields).
 * @param {{ subject?: string, title?: string, intro?: string, body?: string, ctaLabel?: string, footer?: string }} tpl
 * @param {EmailVars} [vars]
 */
function renderEmailFromTemplate(tpl, vars = {}) {
    const ctaUrl = vars.verifyUrl || vars.loginUrl || vars.cta || null;
    // `title` and `ctaLabel` are interpolated into the shell through safeHtml,
    // which escapes them there — so they must arrive as PLAIN TEXT. `intro` and
    // `body` are wrapped in raw() by the shell (the body carries deliberate
    // <br>s), so those two do the escaping here instead.
    //
    // They were all four run through _renderField, which meant title and
    // ctaLabel were escaped twice: a recipient called "Jansen & Zn" saw
    // "Jansen &amp; Zn" in the subject heading of every verification and
    // welcome mail.
    const html = _renderEmailShell({
        title: _substituteVars(tpl.title, vars),
        intro: tpl.intro ? _renderField(tpl.intro, vars) : '',
        body: _renderField(tpl.body, vars, { multiline: true }),
        ctaLabel: tpl.ctaLabel ? _substituteVars(tpl.ctaLabel, vars) : null,
        ctaUrl,
        // Optional, not an editable field: only the collaboration mail has one.
        footer: tpl.footer ? _renderField(tpl.footer, vars) : undefined,
    });

    const subject = _substituteVars(tpl.subject, vars);
    const lines = [_substituteVars(tpl.intro, vars), _substituteVars(tpl.body, vars)].filter(Boolean);
    if (ctaUrl) lines.push(`${_substituteVars(tpl.ctaLabel, vars)}: ${ctaUrl}`.trim());
    const text = lines.join('\n\n');

    return { subject, html, text };
}

/**
 * Build a {subject, html, text} email from a configurable, locale-aware
 * template. Shared by the send functions and the admin preview/test endpoint
 * (no-send path). The CTA URL is taken from vars.verifyUrl / vars.loginUrl.
 *
 * @param {string} templateId  'verification', 'welcome', 'project_collab', …
 * @param {string} locale
 * @param {EmailVars} [vars]
 */
async function renderEmailTemplate(templateId, locale, vars = {}) {
    const languageStore = require('../stores/languageStore');
    const tpl = await languageStore.getEffectiveEmailTemplate(templateId, locale);
    if (!tpl) throw new Error(`Unknown email template '${templateId}'`);
    return renderEmailFromTemplate(tpl, vars);
}

module.exports = { _renderEmailShell, raw, safeHtml, renderEmailFromTemplate, renderEmailTemplate };
