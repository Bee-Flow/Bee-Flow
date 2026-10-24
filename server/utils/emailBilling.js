// @typecheck
const appPaths = require('./appPaths');
const { _renderEmailShell, raw, safeHtml } = require('./emailTemplates');
const { sendServiceEmail } = require('./emailTransport');

/**
 * Send a trial-ending warning email. Stripe fires
 * `customer.subscription.trial_will_end` ~3 days before trial end. The
 * caller is responsible for idempotency (use userStore.claimNotification).
 *
 * @param {{ email: string, displayName?: string, orgName?: string, trialEndIso: string, portalUrl: string }} opts
 */
async function sendTrialEndingEmail({ email, displayName, orgName, trialEndIso, portalUrl }) {
    const clientHost = appPaths.clientHost();
    // PNG, not SVG: most mail clients (Gmail/Outlook) strip SVG. Served from agent-hub/public/.
    const logoUrl = `${clientHost}/bee-flow-logo.png`;
    const targetName = orgName || displayName || 'there';
    const trialEnd = trialEndIso ? new Date(trialEndIso) : null;
    const trialEndPretty = trialEnd ? trialEnd.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' }) : 'soon';
    const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000))) : null;
    const daysLine = daysLeft != null ? `in ${daysLeft} day${daysLeft === 1 ? '' : 's'}` : 'soon';

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
          <h1 style="margin:0;font-size:22px;font-weight:700;color:#0f172a;letter-spacing:-0.3px;">Your trial ends ${daysLine}</h1>
        </td></tr>
        <tr><td style="padding:32px 40px 36px;">
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Hi <strong style="color:#0f172a;">${targetName}</strong>,
          </p>
          <p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:#334155;">
            Your BeeFlow trial ends on <strong style="color:#0f172a;">${trialEndPretty}</strong>. To keep your access without interruption, add a payment method now.
          </p>
          <p style="margin:0 0 28px;font-size:14px;line-height:1.6;color:#64748b;">
            If you don't add a payment method, your subscription will be cancelled automatically when the trial ends.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr><td align="center">
              <a href="${portalUrl}" target="_blank" style="display:inline-block;padding:14px 40px;background:#0f172a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;border-radius:12px;">
                Add Payment Method
              </a>
            </td></tr>
          </table>
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

    const text = `Hi ${targetName},\n\nYour BeeFlow trial ends on ${trialEndPretty}. To keep your access without interruption, add a payment method now:\n\n${portalUrl}\n\nIf you don't add a payment method, your subscription will be cancelled automatically when the trial ends.`;

    return sendServiceEmail({
        to: email,
        subject: `Your BeeFlow trial ends ${daysLine}`,
        text,
        html,
    });
}

/**
 * Payment failed — first failure. Stripe automatically retries per its
 * Smart Retries schedule (typically 3, 5, 7 days). This email is the
 * "heads up" to the customer so they can update their card before retries
 * are exhausted and dunning takes the subscription past_due.
 */
async function sendPaymentFailedEmail({ email, displayName, orgName, portalUrl, attemptCount = 1 }) {
    const targetName = orgName || displayName || 'there';
    const html = _renderEmailShell({
        title: 'Payment failed',
        intro: safeHtml`Hi <strong>${targetName}</strong>,`,
        body: `Your most recent BeeFlow payment didn't go through${attemptCount > 1 ? ` (attempt ${attemptCount})` : ''}. Stripe will automatically retry over the next few days, but you can update your card now to avoid a service interruption.`,
        ctaLabel: 'Update Payment Method',
        ctaUrl: portalUrl,
        footer: 'If you\'ve already updated your card, you can ignore this email.',
    });
    const text = `Hi ${targetName},\n\nYour most recent BeeFlow payment didn't go through${attemptCount > 1 ? ` (attempt ${attemptCount})` : ''}. Stripe will retry automatically. Update your card now to avoid a service interruption:\n\n${portalUrl}`;
    return sendServiceEmail({
        to: email,
        subject: 'BeeFlow: Payment failed — please update your card',
        text,
        html,
    });
}

/**
 * Dunning grace-period warning. Sent when the dunning sweeper notices an
 * org has been past_due for over half the grace window (default 7 days).
 * Last chance before the subscription flips to suspended.
 */
async function sendDunningGraceWarningEmail({ email, displayName, orgName, portalUrl, graceDaysRemaining }) {
    const targetName = orgName || displayName || 'there';
    const html = _renderEmailShell({
        title: 'Your subscription is at risk',
        intro: safeHtml`Hi <strong>${targetName}</strong>,`,
        body: `Your BeeFlow account is past due. If we don\'t receive payment in the next <strong>${graceDaysRemaining} day${graceDaysRemaining === 1 ? '' : 's'}</strong>, AI access will be suspended.`,
        ctaLabel: 'Resolve Now',
        ctaUrl: portalUrl,
        footer: 'Updating your payment method instantly reactivates Stripe retries.',
    });
    const text = `Hi ${targetName},\n\nYour BeeFlow account is past due. If we don't receive payment in the next ${graceDaysRemaining} day(s), AI access will be suspended.\n\nResolve now: ${portalUrl}`;
    return sendServiceEmail({
        to: email,
        subject: `BeeFlow: ${graceDaysRemaining} day${graceDaysRemaining === 1 ? '' : 's'} until your subscription is suspended`,
        text,
        html,
    });
}

/**
 * Subscription suspended (post-dunning). Final-state email confirming AI
 * access is blocked until payment is resolved.
 */
async function sendSubscriptionSuspendedEmail({ email, displayName, orgName, portalUrl }) {
    const targetName = orgName || displayName || 'there';
    const html = _renderEmailShell({
        title: 'Subscription suspended',
        intro: safeHtml`Hi <strong>${targetName}</strong>,`,
        body: 'Your BeeFlow subscription has been suspended because payment couldn\'t be collected. AI features are paused; existing chats and data remain intact. Update your payment method to reactivate.',
        ctaLabel: 'Reactivate Subscription',
        ctaUrl: portalUrl,
    });
    const text = `Hi ${targetName},\n\nYour BeeFlow subscription has been suspended because payment couldn't be collected. AI features are paused; your data is safe. Update your payment method to reactivate:\n\n${portalUrl}`;
    return sendServiceEmail({
        to: email,
        subject: 'BeeFlow: Subscription suspended',
        text,
        html,
    });
}

/**
 * GDPR Art. 33 breach notification. Sent to the recipient list resolved by
 * compliance.js (DPO + org admins). Free-form body so the compliance flow
 * can include incident-specific details (categories of data, affected user
 * count, mitigation steps) without a rigid template.
 *
 * @param {{ to: string | string[], incidentSummary: string, occurredAt: string, ackUrl?: string }} opts
 */
async function sendBreachNotificationEmail({ to, incidentSummary, occurredAt, ackUrl }) {
    const html = _renderEmailShell({
        title: 'Data incident notification',
        // incidentSummary is operator-written free text and goes out to every
        // affected organisation's contact address under GDPR Art. 33/34.
        body: safeHtml`A security incident has been recorded that may affect your organization's data. <br/><br/><strong>Occurred:</strong> ${occurredAt}<br/><br/>${incidentSummary}`,
        ctaLabel: ackUrl ? 'Open Incident Report' : null,
        ctaUrl: ackUrl || null,
        footer: 'This notification is sent in accordance with GDPR Art. 33 / 34. Please coordinate with your DPO before disclosing details outside your organization.',
    });
    const text = `Data incident notification.\n\nOccurred: ${occurredAt}\n\n${incidentSummary}\n\n${ackUrl ? `Open: ${ackUrl}` : ''}`;
    return sendServiceEmail({
        to,
        subject: 'BeeFlow: Data incident notification',
        text,
        html,
    });
}

/**
 * Admin notification — a new subscription was started. Sent to the address
 * configured in Admin → Subscriptions → Stripe (`subscription_notify_email`),
 * once per new subscription. The webhook is responsible for idempotency
 * (userStore.claimNotification) so subscription *updates* never re-trigger.
 *
 * @param {{ to: string, scope?: string, targetName?: string, planName?: string, price?: number|string, currency?: string, interval?: string, trialDays?: number, adminUrl?: string }} opts
 */
async function sendSubscriptionStartedAdminEmail({ to, scope, targetName, planName, price, currency, interval, trialDays, adminUrl }) {
    const fmtPrice = (price !== undefined && price !== null && price !== '')
        ? `${currency || 'EUR'} ${price}${interval ? ` / ${interval === 'yearly' ? 'year' : 'month'}` : ''}`
        : '—';
    const rows = [
        ['Customer', targetName || '—'],
        ['Type', scope === 'consumer' ? 'Personal account' : 'Organisation'],
        ['Plan', planName || '—'],
        ['Price', fmtPrice],
        ...(trialDays ? [['Trial', `${trialDays} day${trialDays === 1 ? '' : 's'}`]] : []),
    ];
    // Customer and plan names reach this table from the subscription record,
    // which traces back to org text the customer wrote.
    const tableRows = rows.map(([k, v]) =>
        safeHtml`<tr><td style="padding:6px 12px;color:#64748b;font-size:14px;">${k}</td><td style="padding:6px 12px;color:#0f172a;font-size:14px;font-weight:600;">${v}</td></tr>`
    ).join('');
    const html = _renderEmailShell({
        title: 'New subscription started',
        body: safeHtml`A customer just started a new subscription on Bee Flow.
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;border-spacing:0;">${raw(tableRows)}</table>`,
        ctaLabel: adminUrl ? 'Open admin dashboard' : null,
        ctaUrl: adminUrl || null,
        footer: 'You are receiving this because a notification email is set in Admin → Subscriptions → Stripe.',
    });
    const text = `New subscription started on Bee Flow.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${adminUrl ? `\n\nAdmin: ${adminUrl}` : ''}`;
    return sendServiceEmail({
        to,
        subject: `Bee Flow: new subscription — ${planName || 'plan'}${targetName ? ` (${targetName})` : ''}`,
        text,
        html,
    });
}

/**
 * Customer confirmation after the first successful subscription payment:
 * plan, amount, billing cycle, next billing date and (when Stripe provides
 * one) a link to the hosted invoice. The caller is responsible for
 * idempotency (userStore.claimNotification). Goes to the subscriber only.
 *
 * @param {{ email: string, displayName?: string, orgName?: string, planName?: string, amount?: number|string, currency?: string, interval?: string, nextBillingIso?: string, invoiceUrl?: string, portalUrl?: string }} opts
 */
async function sendSubscriptionConfirmationEmail({ email, displayName, orgName, planName, amount, currency, interval, nextBillingIso, invoiceUrl, portalUrl }) {
    const name = orgName || displayName || 'there';
    const cycle = interval === 'yearly' ? 'Yearly' : interval === 'monthly' ? 'Monthly' : '—';
    const hasAmount = amount !== undefined && amount !== null && amount !== '';
    const amountText = hasAmount ? `${String(currency || 'EUR').toUpperCase()} ${Number(amount).toFixed(2)}` : '—';
    const next = nextBillingIso ? new Date(nextBillingIso) : null;
    const nextText = next && !Number.isNaN(next.getTime())
        ? next.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' })
        : '—';
    const rows = [
        ['Plan', planName || '—'],
        ['Amount paid', amountText],
        ['Billing cycle', cycle],
        ['Next billing date', nextText],
    ];
    const tableRows = rows.map(([k, v]) =>
        safeHtml`<tr><td style="padding:6px 12px;color:#64748b;font-size:14px;">${k}</td><td style="padding:6px 12px;color:#0f172a;font-size:14px;font-weight:600;">${v}</td></tr>`
    ).join('');
    const link = invoiceUrl || portalUrl || null;
    const html = _renderEmailShell({
        title: 'Payment successful',
        intro: safeHtml`Hi <strong>${name}</strong>,`,
        body: safeHtml`Thank you. Your payment was received and your Bee Flow subscription is now active.
            <table width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e2e8f0;border-radius:12px;border-collapse:separate;border-spacing:0;">${raw(tableRows)}</table>`,
        ctaLabel: link ? (invoiceUrl ? 'View invoice' : 'Manage subscription') : null,
        ctaUrl: link,
        footer: 'You are receiving this because a subscription was started for your account.',
    });
    const text = `Hi ${name},\n\nYour payment was received and your Bee Flow subscription is now active.\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}${link ? `\n\n${invoiceUrl ? 'Invoice' : 'Manage subscription'}: ${link}` : ''}`;
    return sendServiceEmail({
        to: email,
        subject: `Bee Flow: payment successful${planName ? ` — ${planName}` : ''}`,
        text,
        html,
    });
}

module.exports = { sendTrialEndingEmail, sendPaymentFailedEmail, sendDunningGraceWarningEmail, sendSubscriptionSuspendedEmail, sendBreachNotificationEmail, sendSubscriptionStartedAdminEmail, sendSubscriptionConfirmationEmail };
