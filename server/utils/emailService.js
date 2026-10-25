// @typecheck
/**
 * Email Service — Gmail API sender using OAuth2 (configStore credentials)
 *
 * Provides a reusable `sendServiceEmail()` function for sending
 * customer-facing emails from the platform's configured service account.
 *
 * Transport is the Gmail REST API over HTTPS (port 443), NOT SMTP. Scaleway
 * (and most cloud hosts) block outbound SMTP (25/465/587) for anti-abuse, so
 * the App-Password/SMTP path timed out in production. OAuth2 + the Gmail API
 * runs entirely over 443 — the same path the Support inbox already uses
 * (see services/email/providerClients.js) — and survives node replacement.
 *
 * The admin connects a Google account once (Admin → Integrations → Email);
 * the resulting refresh-token blob is stored encrypted via configStore.setSecret
 * under `service_email_oauth_tokens`, and the connected address under the config
 * key `service_email_address`. Access tokens are auto-refreshed and written back.
 */

const appPaths = require('./appPaths');
const log = require('../telemetry/log');
const { _renderEmailShell, raw, safeHtml, renderEmailFromTemplate, renderEmailTemplate } = require('./emailTemplates');
const { getServiceEmailConfig, buildConnectUrl, completeOAuthConnect, disconnectServiceEmail, sendServiceEmail } = require('./emailTransport');
const { sendDsrAckEmail, sendDsrExtensionEmail, sendDsrResultEmail } = require('./emailDsr');
const { sendTrialEndingEmail, sendPaymentFailedEmail, sendDunningGraceWarningEmail, sendSubscriptionSuspendedEmail, sendBreachNotificationEmail, sendSubscriptionStartedAdminEmail, sendSubscriptionConfirmationEmail } = require('./emailBilling');

// ── OAuth token storage (encrypted at rest via configStore.setSecret) ────────

// ── OAuth connect lifecycle (drives Admin → Integrations → Email) ─────────────

/**
 * Send a branded invitation email.
 * @param {{ email: string, orgName: string, inviterName: string, inviteUrl: string, role?: string }} opts
 */
async function sendInvitationEmail({ email, orgName, inviterName, inviteUrl, role }) {
    const roleLabel = role && role !== 'user' ? role.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';

    const clientHost = appPaths.clientHost();
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;

    const html = safeHtml`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <!-- Header -->
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">You're invited!</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px 36px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            <strong style="color:#0f172a;">${inviterName}</strong> has invited you to join
            <strong style="color:#0f172a;">${orgName}</strong> on BeeFlow${raw(roleLabel ? safeHtml` as <strong style="color:#6b7280;">${roleLabel}</strong>` : '')}.
          </p>
          <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#64748b;">
            Click the button below to create your account and get started.
          </p>
          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${inviteUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                Accept Invitation
              </a>
            </td></tr>
          </table>
          <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">
            This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
          </p>
        </td></tr>
        <!-- Footer -->
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

    const text = `${inviterName} has invited you to join ${orgName} on BeeFlow${roleLabel ? ` as ${roleLabel}` : ''}.\n\nAccept your invitation: ${inviteUrl}\n\nThis invitation expires in 7 days.`;

    return sendServiceEmail({
        to: email,
        subject: `You're invited to join ${orgName} on BeeFlow`,
        text,
        html,
    });
}

/**
 * Send a branded waitlist approval email.
 * @param {{ email: string, displayName: string }} opts
 */
async function sendWaitlistApprovedEmail({ email, displayName }) {
    const clientHost = appPaths.clientHost();
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;
    const loginUrl = clientHost;

    const html = safeHtml`
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:48px 20px;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;border:1px solid rgba(0,0,0,0.06);overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,0.05);">
        <!-- Header -->
        <tr><td style="padding:36px 40px 28px;text-align:center;border-bottom:1px solid #f0f0f0;">
          <img src="${logoUrl}" alt="BeeFlow" width="56" height="56" style="display:block;margin:0 auto 16px;border-radius:14px;" />
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">You're approved! 🎉</h1>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px 40px 36px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Hi <strong style="color:#0f172a;">${displayName}</strong>,
          </p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Great news — your BeeFlow account has been approved! You can now log in and start using the platform.
          </p>
          <!-- CTA -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${loginUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                Log In Now
              </a>
            </td></tr>
          </table>
          <p style="margin:28px 0 0;font-size:12px;line-height:1.5;color:#94a3b8;">
            If you didn't create an account on BeeFlow, you can safely ignore this email.
          </p>
        </td></tr>
        <!-- Footer -->
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

    const text = `Hi ${displayName},\n\nGreat news — your BeeFlow account has been approved! You can now log in and start using the platform.\n\nLog in: ${loginUrl}\n\nIf you didn't create an account on BeeFlow, you can safely ignore this email.`;

    return sendServiceEmail({
        to: email,
        subject: 'Your BeeFlow account has been approved!',
        text,
        html,
    });
}

// ── Configurable template helpers (verification + welcome) ──────────────
// Admin-authored templates are structured PLAIN-TEXT fields rendered into the
// branded shell. We treat all field content as plain text: substitute the
// {{variables}}, HTML-escape the result, then (for the body) turn newlines
// into <br>. This keeps user-supplied values (name/orgName) and any stray
// markup from breaking the HTML.

/**
 * Email-address verification. The raw token only ever travels in `verifyUrl`
 * (the DB stores SHA-256(token)). Sent at signup when verification is enabled.
 *
 * @param {{ email: string, displayName?: string, verifyUrl: string, orgName?: string, locale?: string }} opts
 */
async function sendVerificationEmail({ email, displayName, verifyUrl, orgName, locale }) {
    const vars = { name: displayName || 'there', verifyUrl, orgName: orgName || 'BeeFlow' };
    const { subject, html, text } = await renderEmailTemplate('verification', locale, vars);
    return sendServiceEmail({ to: email, subject, text, html });
}

/**
 * The Learning Center link in the welcome email. BFSF-230 made the
 * confirmation email an onboarding touchpoint; BFSF-279: the link pointed at
 * the app root, which lands a new user on the dashboard instead of the
 * Learning Center the email promises. Derived from the same client host as
 * the other links.
 */
function welcomeLearnUrl() {
    return `${appPaths.clientHost()}${appPaths.learningSettingsPath()}`;
}

/**
 * Welcome / confirmation email. Sent once an account first becomes active
 * (after verification for verified signups; on creation for trusted accounts).
 *
 * @param {{ email: string, displayName?: string, loginUrl: string, orgName?: string, locale?: string }} opts
 */
async function sendWelcomeEmail({ email, displayName, loginUrl, orgName, locale }) {
    const vars = { name: displayName || 'there', loginUrl, learnUrl: welcomeLearnUrl(), orgName: orgName || 'BeeFlow' };
    const { subject, html, text } = await renderEmailTemplate('welcome', locale, vars);
    return sendServiceEmail({ to: email, subject, text, html });
}

/**
 * Mail of one project collaboration event (a mention, being added, ...). The
 * mail carries only the project name, the actor's display name, the kind of
 * event, a short fixed sentence and an in-app link: never what was written.
 * Best effort: no service mailbox or a failed send gives `{ sent: false }`,
 * it never throws (the bell of the same event has already rung).
 *
 * @param {{ userId: string, locale?: string, event: string, vars?: { project?: string, actor?: string, intro?: string, detail?: string }, ctaUrl?: string|null }} opts
 * @param {any} [deps]  injectable for tests
 * @returns {Promise<{ sent: boolean }>}
 */
async function sendProjectCollabEmail({ userId, locale, event, vars = {}, ctaUrl = null }, deps = {}) {
    try {
        const config = await (deps.getServiceEmailConfig || getServiceEmailConfig)();
        if (!config.configured) {
            log.debug('[EmailService] collaboration mail not sent: service mailbox not configured');
            return { sent: false };
        }
        const user = await (deps.getUser || ((id) => require('../stores/userStore').getUser(id)))(userId);
        if (!user || !user.email) return { sent: false };
        const lang = locale || user.preferredLocale || 'en';
        const translate = deps.translate || ((l, k, v) => require('../i18n/translate').translate(l, k, v));
        // Built from named fields only: nothing else of the event travels in the mail.
        const allowed = {
            event: await translate(lang, `project_collab.email.${event}.event`, {}),
            project: vars.project || '',
            actor: vars.actor || '',
            intro: vars.intro || '',
            detail: vars.detail || '',
            cta: ctaUrl || '',
        };
        const { subject, html, text } = await (deps.renderTemplate || renderEmailTemplate)('project_collab', lang, allowed);
        const result = await (deps.sendServiceEmail || sendServiceEmail)({ to: user.email, subject, text, html });
        if (!result || result.success === false) {
            log.warn(`[EmailService] collaboration mail (${event}) not sent: ${(result && result.error) || 'unknown error'}`);
            return { sent: false };
        }
        return { sent: true };
    } catch (err) {
        log.warn(`[EmailService] collaboration mail (${event}) not sent: ${err && err.message}`);
        return { sent: false };
    }
}

// ── DSR letters to the data subject (GDPR Art. 12) ──────────────────────
// The ONE place personal data leaves Bee Flow (BFSF-441): the recipient is the
// data subject, so their address is the channel. Everything else is
// allow-listed — the senders take named fields and nothing from a row, the
// subject line carries only the request number and type, and the body never
// repeats the address. Templates: i18n/defaults/emailTemplates.js
// (dsr_ack / dsr_extension / dsr_result, EN + NL, admin-editable per locale).

/**
 * Nextcloud connector pairing — one-time verification code. Sent when a
 * Nextcloud install's admin email matches an existing Bee Flow organisation
 * (same domain). The admin types the code into the embedded Bee Flow view in
 * Nextcloud to confirm the link — no external login required. Never log or
 * return the code anywhere else; this email is the only place it appears.
 *
 * @param {{ to: string, code: string, orgName?: string, expiresAt?: string }} opts
 */
async function sendNcVerificationCodeEmail({ to, code, orgName, expiresAt }) {
    const minutes = expiresAt
        ? Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000))
        : 15;
    // orgName is writable through unauthenticated signup, so this is the one
    // fragment here whose value an outsider chooses.
    const orgLine = orgName
        ? safeHtml`link this Nextcloud to <strong>${orgName}</strong>`
        : 'link this Nextcloud to your Bee Flow organisation';
    const html = _renderEmailShell({
        title: 'Your Nextcloud connection code',
        body: safeHtml`Enter this code in the Bee Flow app inside Nextcloud to ${raw(orgLine)}:
            <div style="margin:24px 0;text-align:center;">
              <span style="display:inline-block;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f172a;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:16px 24px;font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;">${code}</span>
            </div>
            <p style="margin:0;font-size:13px;color:#64748b;">This code expires in ${minutes} minute${raw(minutes === 1 ? '' : 's')}.</p>`,
        footer: 'If you didn\'t install the Bee Flow app on Nextcloud, you can safely ignore this email — no connection will be made.',
    });
    const text = `Your Bee Flow Nextcloud connection code: ${code}\n\nEnter this code in the Bee Flow app inside Nextcloud to ${orgName ? `link this Nextcloud to ${orgName}` : 'link this Nextcloud to your Bee Flow organisation'}.\n\nThis code expires in ${minutes} minute(s).\n\nIf you didn't install the Bee Flow app on Nextcloud, you can safely ignore this email.`;
    return sendServiceEmail({
        to,
        subject: `Bee Flow: your Nextcloud connection code is ${code}`,
        text,
        html,
    });
}

/**
 * Self-service password reset link. The raw token only ever travels in this
 * email (the DB stores SHA-256(token)). Link expires in 60 minutes.
 *
 * @param {{ email: string, displayName?: string, resetUrl: string }} opts
 */
async function sendPasswordResetEmail({ email, displayName, resetUrl }) {
    const name = displayName || 'there';
    const html = _renderEmailShell({
        title: 'Reset your password',
        intro: safeHtml`Hi <strong>${name}</strong>,`,
        body: 'We received a request to reset your Bee Flow password. Click the button below to choose a new one. This link expires in 1 hour and can be used once. If you didn\'t request this, you can safely ignore this email — your password won\'t change.',
        ctaLabel: 'Reset password',
        ctaUrl: resetUrl,
        footer: 'For your security, this link expires in 60 minutes and can only be used once.',
    });
    const text = `Hi ${name},\n\nReset your Bee Flow password using the link below (expires in 1 hour):\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your password won't change.`;
    return sendServiceEmail({
        to: email,
        subject: 'Reset your Bee Flow password',
        text,
        html,
    });
}

module.exports = {
    getServiceEmailConfig,
    sendServiceEmail,
    buildConnectUrl,
    completeOAuthConnect,
    disconnectServiceEmail,
    _renderEmailShell,
    renderEmailFromTemplate,
    renderEmailTemplate,
    sendVerificationEmail,
    sendWelcomeEmail,
    welcomeLearnUrl,
    sendNcVerificationCodeEmail,
    sendPasswordResetEmail,
    sendInvitationEmail,
    sendProjectCollabEmail,
    sendWaitlistApprovedEmail,
    sendTrialEndingEmail,
    sendPaymentFailedEmail,
    sendDunningGraceWarningEmail,
    sendSubscriptionSuspendedEmail,
    sendBreachNotificationEmail,
    sendSubscriptionStartedAdminEmail,
    sendSubscriptionConfirmationEmail,
    sendDsrAckEmail,
    sendDsrExtensionEmail,
    sendDsrResultEmail,
};

/**
 * @typedef {{ subject?: string, title?: string, intro?: string, body?: string, ctaLabel?: string, footer?: string }} EmailTemplateFields
 * @typedef {{ verifyUrl?: string, loginUrl?: string, cta?: string, [k: string]: unknown }} EmailVars
 */
