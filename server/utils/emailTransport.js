// @typecheck
const configStore = require('../stores/configStore');
const log = require('../telemetry/log');

const OAUTH_TOKENS_KEY = 'service_email_oauth_tokens';

/** Load the stored Gmail OAuth token blob, or null if not connected. */
async function _loadOAuthTokens() {
    const raw = await configStore.getSecret(OAUTH_TOKENS_KEY);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

/** Persist (or clear, when blob is falsy) the Gmail OAuth token blob. */
async function _saveOAuthTokens(blob) {
    await configStore.setSecret(OAUTH_TOKENS_KEY, blob ? JSON.stringify(blob) : '');
}

/**
 * Get the current service email configuration (without exposing tokens).
 * `configured` is true only when a Google account is connected (refresh token
 * present) and an address is stored.
 * @returns {Promise<{ configured: boolean, address: string, displayName: string }>}
 */
async function getServiceEmailConfig() {
    const address = await configStore.getConfig('service_email_address');
    const tokens = await _loadOAuthTokens();
    const displayName = await configStore.getConfig('service_email_display_name') || '';
    const configured = !!(address && tokens && tokens.refreshToken);
    log.info(`[EmailService] Config: address=${address || '(empty)'}, connected=${configured}, displayName=${displayName || '(empty)'}`);
    return { configured, address: address || '', displayName };
}

/**
 * Build the Google consent URL for connecting the platform service account.
 * Reuses the shared Gmail OAuth client + gmail.send scope from providerClients.
 * @param {{ redirectUri: string, state: string }} opts
 * @returns {Promise<string>}
 */
async function buildConnectUrl({ redirectUri, state }) {
    const providerClients = require('../services/email/providerClients');
    return providerClients.buildAuthUrl('gmail', { redirectUri, state });
}

/**
 * Complete the OAuth connect: exchange the authorization code, store the token
 * blob + the connected Gmail address. The address Google reports IS the only
 * valid `From` for Gmail-API sends, so we trust it over any prior value.
 * @param {{ code: string, redirectUri: string }} opts
 * @returns {Promise<{ address: string }>}
 */
async function completeOAuthConnect({ code, redirectUri }) {
    const providerClients = require('../services/email/providerClients');
    const { tokens, emailAddress } = await providerClients.exchangeCode('gmail', { code, redirectUri });
    await _saveOAuthTokens(tokens);
    await configStore.setConfig('service_email_address', emailAddress || '');
    log.info(`[EmailService] Connected service email account: ${emailAddress}`);
    return { address: emailAddress };
}

/** Disconnect the service account — clears tokens and the stored address. */
async function disconnectServiceEmail() {
    await _saveOAuthTokens(null);
    await configStore.setConfig('service_email_address', '');
    log.info('[EmailService] Service email disconnected');
}

/**
 * Build a base64url-encoded RFC822 message for the Gmail API `messages.send`
 * `raw` field, using nodemailer's MailComposer (same approach as supportMailer).
 */
async function _buildRawMessage({ from, to, cc, bcc, replyTo, subject, text, html }) {
    // nodemailer 10 ships its own declarations with `export default`; the
    // CommonJS build sets `.default` too, so this is the class at runtime and
    // for the typecheck alike.
    const MailComposer = require('nodemailer/lib/mail-composer').default;
    const composer = new MailComposer({
        from, to, cc: cc || undefined, bcc: bcc || undefined, replyTo: replyTo || undefined,
        subject, text: text || undefined, html: html || undefined,
    });
    const msg = await new Promise((resolve, reject) => {
        composer.compile().build((err, m) => (err ? reject(err) : resolve(m)));
    });
    return msg.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Send an email using the configured service email account.
 * 
 * @param {Object} options
 * @param {string|string[]} options.to       - Recipient(s)
 * @param {string}          options.subject  - Email subject
 * @param {string}          [options.text]   - Plain-text body
 * @param {string}          [options.html]   - HTML body
 * @param {string}          [options.cc]     - CC recipients
 * @param {string}          [options.bcc]    - BCC recipients
 * @param {string}          [options.replyTo] - Reply-to address
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendServiceEmail({ to, subject, text, html, cc, bcc, replyTo }) {
    log.info(`[EmailService] sendServiceEmail — to=${to}, subject="${subject}"`);
    try {
        const address = await configStore.getConfig('service_email_address');
        const tokens = await _loadOAuthTokens();
        if (!address || !tokens || !tokens.refreshToken) {
            throw new Error('Service email is not connected. Connect a Google account in Admin → Integrations → Email.');
        }

        const { gmailClientFromTokens } = require('../services/email/providerClients');
        // Refreshed access tokens are written back so the next send reuses them.
        const gmail = await gmailClientFromTokens(tokens, (updated) => _saveOAuthTokens(updated));

        const fromName = (await configStore.getConfig('service_email_display_name')) || 'Service';
        // Gmail rewrites `From` to the authenticated account unless it's a verified
        // send-as alias, so `address` (the connected account) is the correct sender.
        const raw = await _buildRawMessage({
            from: `"${fromName}" <${address}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            cc, bcc, replyTo, subject, text, html,
        });

        log.info(`[EmailService] Sending via Gmail API from "${fromName}" <${address}> → ${to}`);
        const sent = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });

        log.info(`[EmailService] ✅ Email sent: ${sent.data.id} → ${to}`);
        return {
            success: true,
            messageId: sent.data.id,
        };
    } catch (error) {
        log.error(`[EmailService] ❌ Failed to send email:`, error.message);
        log.error(`[EmailService] Full error:`, error.stack || error);
        return {
            success: false,
            error: error.message,
        };
    }
}

module.exports = { getServiceEmailConfig, buildConnectUrl, completeOAuthConnect, disconnectServiceEmail, sendServiceEmail };
