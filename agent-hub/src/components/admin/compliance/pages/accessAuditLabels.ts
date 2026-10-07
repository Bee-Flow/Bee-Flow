import { Eye, FileDown, Globe, LogIn, LogOut, ScrollText, Search, ShieldOff, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { formatStamp } from '../shared/formatDates';
import { userName } from './audits/auditForms';

/**
 * accessAuditLabels: how an access-log row reads (AccessAuditPage). Names,
 * not ids: an event reads as words (an action this file does not know is
 * humanised, never printed as its raw key), the actor by display name, and a
 * data-subject request as "Request #2417".
 *
 * Redaction (BFSF-441): a refused sign-in NEVER renders what was typed. The
 * identifier fingerprint is a correlation handle, shown as a short tag, never
 * as a value to read, and the detail line comes from an allow-list of
 * payload keys, never from the whole payload.
 */

type Translate = (key: string, fallback: string, vars?: Record<string, unknown>) => string;
type Tone = 'success' | 'warning' | 'error' | 'neutral';

export interface ActionMeta {
    icon: LucideIcon;
    tone: Tone;
    key: string | null;
    en: string;
}

export interface AccessAuditRow {
    id?: string | number;
    action?: string | null;
    target_type?: string | null;
    target_id?: string | null;
    changed_by?: string | null;
    created_at?: string | null;
    new_values?: Record<string, unknown> | null;
}

export interface OrgUser {
    id: string | number;
    displayName?: string | null;
    email?: string | null;
}

/** Actions the log writes, so the list reads as events rather than ids. */
export const ACTION_META: Readonly<Record<string, ActionMeta>> = {
    login_succeeded: { icon: LogIn, tone: 'success', key: 'compliance.aa_action_login_ok', en: 'Signed in' },
    login_failed: { icon: LogOut, tone: 'warning', key: 'compliance.aa_action_login_fail', en: 'Sign-in refused' },
    login_blocked: { icon: ShieldOff, tone: 'error', key: 'compliance.aa_action_login_blocked', en: 'Sign-in blocked' },
    studio_app_published: { icon: Users, tone: 'neutral', key: 'compliance.aa_action_app_published', en: 'App published' },
    studio_app_unpublished: { icon: Users, tone: 'neutral', key: 'compliance.aa_action_app_unpublished', en: 'App unpublished' },
    studio_app_public_page_created: { icon: Globe, tone: 'error', key: 'compliance.aa_action_public_page_created', en: 'Public URL created' },
    studio_app_public_page_revoked: { icon: Globe, tone: 'neutral', key: 'compliance.aa_action_public_page_revoked', en: 'Public URL revoked' },
    'dsr.subject_viewed': { icon: Eye, tone: 'neutral', key: 'compliance.aa_action_dsr_subject_viewed', en: 'Request opened' },
    'dsr.discovery_run': { icon: Search, tone: 'neutral', key: 'compliance.aa_action_dsr_discovery_run', en: 'Data search run' },
    'dsr.dossier_exported': { icon: FileDown, tone: 'neutral', key: 'compliance.aa_action_dsr_dossier_exported', en: 'Dossier exported' },
};

/** 'dsr.something_new' → 'Something new': an unknown action in words, never its raw key. */
export function humanizeAction(action: unknown): string {
    const words = (String(action ?? '').split('.').pop() || '').replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '—';
}

export function metaFor(action: unknown): ActionMeta {
    const known = typeof action === 'string' && Object.hasOwn(ACTION_META, action) ? ACTION_META[action] : undefined;
    return known || { icon: ScrollText, tone: 'neutral', key: null, en: humanizeAction(action) };
}

/** The event's words in the language on screen. */
export function actionLabel(action: unknown, t: Translate): string {
    const meta = metaFor(action);
    return meta.key ? t(meta.key, meta.en) : meta.en;
}

/** "19 Aug 20:38:05": seconds included — a minute is not enough to order a burst of failures. */
export function when(iso: string | null | undefined, locale = 'en'): string {
    if (!iso) return '—';
    return formatStamp(iso, locale) || String(iso);
}

/** The number a person reads for a request: the stored id without a `dsr_` prefix. */
export function requestRef(id: unknown): string {
    return String(id ?? '').replace(/^dsr_/, '');
}

/**
 * The actor as a name (the id when the roster does not know them), or null
 * for nobody: loginAudit writes 'anonymous' for a sign-in without an account
 * and 'system' for one the platform made itself.
 */
export function actorName(row: AccessAuditRow | null | undefined, orgUsers: OrgUser[] | null | undefined, t: Translate): string | null {
    const id = row?.changed_by;
    if (!id || id === 'anonymous') return null;
    if (id === 'system') return t('compliance.aa_actor_system', 'System');
    return userName(orgUsers, id) as string | null;
}

/**
 * What a row is ABOUT, in one line — never the raw payload, and never the
 * fingerprint: an account name that matched nothing is shown as exactly that.
 * A sign-in names the account by its id (auth/loginAudit.js), so the subject
 * is that account's name when the roster knows it.
 */
export function subjectOf(row: AccessAuditRow, t: Translate, orgUsers: OrgUser[] | null = null): string | null | undefined {
    const d = row.new_values || {};
    if (row.target_type === 'login_identifier') {
        return t('compliance.aa_subject_unknown_account', 'an account name that matched nothing');
    }
    if (row.target_type === 'user' && row.target_id) {
        return userName(orgUsers, row.target_id) as string | null;
    }
    if (row.target_type === 'studio_app') {
        return (typeof d.appName === 'string' && d.appName) || row.target_id;
    }
    if (row.target_type === 'dsr_request' && row.target_id) {
        return t('compliance.aa_subject_request', 'Request #{id}', { id: requestRef(row.target_id) });
    }
    return row.target_id;
}

/**
 * The reason codes auth/loginAudit.js callers write for a refused or blocked
 * sign-in, in words. Lower case: they sit mid-line in the detail.
 */
const REASON_META: Readonly<Record<string, { key: string; en: string }>> = {
    invalid_credentials: { key: 'compliance.aa_reason_invalid_credentials', en: 'wrong credentials' },
    throttled: { key: 'compliance.aa_reason_throttled', en: 'too many attempts' },
    account_suspended: { key: 'compliance.aa_reason_account_suspended', en: 'account suspended' },
    mfa_invalid_code: { key: 'compliance.aa_reason_mfa_invalid_code', en: 'wrong verification code' },
    security_key_rejected: { key: 'compliance.aa_reason_security_key_rejected', en: 'security key rejected' },
    password_login_disabled: { key: 'compliance.aa_reason_password_login_disabled', en: 'password sign-in is off' },
};

/**
 * A row's `reason` as words: a known code in the language on screen, another
 * code ('protocol_error') humanised, never printed raw, and free text as written.
 */
export function reasonLabel(reason: unknown, t: Translate): string | null {
    if (typeof reason !== 'string' || !reason) return null;
    const known = Object.hasOwn(REASON_META, reason) ? REASON_META[reason] : undefined;
    if (known) return t(known.key, known.en);
    // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- each repeat starts with '_', which the class excludes, so there is one way to match: linear
    return /^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(reason) ? reason.replace(/_/g, ' ') : reason;
}

/** The detail line, from an explicit allow-list of payload keys. */
export function detailOf(row: AccessAuditRow, t: Translate): string {
    const d = row.new_values || {};
    return [
        d.method,
        reasonLabel(d.reason, t),
        d.audience,
        d.ip,
        d.identifierFingerprint
            ? t('compliance.aa_same_name_tag', 'same-name tag {tag}', { tag: String(d.identifierFingerprint).slice(-6) })
            : null,
    ].filter(Boolean).join(' · ') || '—';
}
