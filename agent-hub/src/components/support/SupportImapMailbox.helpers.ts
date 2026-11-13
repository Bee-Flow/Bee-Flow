import type { CompanyImapMailbox, MailSecurity } from './SupportInboxPanel.types';

/** The mailbox form as typed. Ports stay text while typing. */
export interface ImapForm {
    emailAddress: string;
    displayName: string;
    imapHost: string;
    imapPort: string;
    imapSecurity: MailSecurity;
    folder: string;
    smtpHost: string;
    smtpPort: string;
    smtpSecurity: MailSecurity;
    username: string;
    password: string;
    separateSmtpLogin: boolean;
    smtpUsername: string;
    smtpPassword: string;
    aiAutoReply: boolean;
}

/** The usual port per protocol and security. */
export const DEFAULT_PORTS: Record<'imap' | 'smtp', Record<MailSecurity, number>> = {
    imap: { tls: 993, starttls: 143 },
    smtp: { tls: 465, starttls: 587 },
};

const EMPTY_FORM: ImapForm = {
    emailAddress: '',
    displayName: '',
    imapHost: '',
    imapPort: String(DEFAULT_PORTS.imap.tls),
    imapSecurity: 'tls',
    folder: 'INBOX',
    smtpHost: '',
    smtpPort: String(DEFAULT_PORTS.smtp.starttls),
    smtpSecurity: 'starttls',
    username: '',
    password: '',
    separateSmtpLogin: false,
    smtpUsername: '',
    smtpPassword: '',
    aiAutoReply: false,
};

/** The form for a stored mailbox (passwords never come back, so they start empty). */
export function formFromMailbox(m: CompanyImapMailbox | null | undefined): ImapForm {
    if (!m) return { ...EMPTY_FORM };
    return {
        ...EMPTY_FORM,
        emailAddress: m.emailAddress,
        displayName: m.displayName,
        imapHost: m.imap.host,
        imapPort: String(m.imap.port),
        imapSecurity: m.imap.security,
        folder: m.imap.folder,
        smtpHost: m.smtp.host,
        smtpPort: String(m.smtp.port),
        smtpSecurity: m.smtp.security,
        username: m.username,
        separateSmtpLogin: !!m.smtpUsername,
        smtpUsername: m.smtpUsername ?? '',
        aiAutoReply: m.aiAutoReply,
    };
}

/**
 * Switching TLS ↔ STARTTLS moves the port along while it is still the usual
 * one; a port someone typed themselves stays.
 */
export function portAfterSecurityChange(kind: 'imap' | 'smtp', from: MailSecurity, to: MailSecurity, port: string): string {
    return port.trim() === String(DEFAULT_PORTS[kind][from]) ? String(DEFAULT_PORTS[kind][to]) : port;
}

/** Guess the servers from the address: mail.example.com for both, a starting point only. */
export function suggestHosts(emailAddress: string): { imapHost: string; smtpHost: string } | null {
    const at = emailAddress.lastIndexOf('@');
    const domain = at > 0 ? emailAddress.slice(at + 1).trim().toLowerCase() : '';
    if (!domain || !domain.includes('.')) return null;
    return { imapHost: `imap.${domain}`, smtpHost: `smtp.${domain}` };
}

/** The request body. Empty passwords are left out: the server keeps the stored ones for the same account. */
export function bodyFromForm(f: ImapForm) {
    return {
        emailAddress: f.emailAddress.trim(),
        displayName: f.displayName.trim(),
        imap: { host: f.imapHost.trim(), port: Number(f.imapPort), security: f.imapSecurity, folder: f.folder.trim() || 'INBOX' },
        smtp: { host: f.smtpHost.trim(), port: Number(f.smtpPort), security: f.smtpSecurity },
        username: f.username.trim() || f.emailAddress.trim(),
        ...(f.password ? { password: f.password } : {}),
        smtpUsername: f.separateSmtpLogin && f.smtpUsername.trim() ? f.smtpUsername.trim() : null,
        ...(f.separateSmtpLogin && f.smtpPassword ? { smtpPassword: f.smtpPassword } : {}),
        aiAutoReply: f.aiAutoReply,
    };
}

/** POST /mailbox/imap/test and a refused PUT carry this. */
export interface ImapTestResult {
    ok: boolean;
    imap: { ok: boolean; error?: string };
    smtp: { ok: boolean; error?: string };
}
