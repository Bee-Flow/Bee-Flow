/**
 * The Frappe CRM connection fields as the settings form sends them, shared by
 * POST /ai/user-settings (saves them) and POST /ai/frappe-crm/test (tries them
 * unsaved). One shape, so a value the test accepts is a value Save accepts.
 *
 * Every field is text; '' (or null) means "not set" / disconnect. The site
 * address goes through the same check the tools run before every request
 * (integrations/frappeCrmHost.mts), so a private address in cloud mode is
 * refused at save time with the sentence that names the operator setting.
 * The key and the secret travel in the Authorization header, so their shape
 * (printable ASCII, no spaces, no ':' in the key) is the header-injection guard.
 */

import { createRequire } from 'node:module';
import { checkSiteUrl, MAX_URL_LENGTH } from '../../../integrations/frappeCrmHost.mts';
import { isValidCredential } from '../../../integrations/frappeCrmClient.mts';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../../../utils/zod.js') as typeof import('../../../utils/zod.js');

const URL_TEXT = 'The Frappe CRM address is the address of your site, like https://yourcompany.frappe.cloud.';
const KEY_TEXT = 'The Frappe CRM API key is invalid. Paste the key from User > API Access, with no spaces.';
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a validation message, not a credential
const SECRET_TEXT = 'The Frappe CRM API secret is invalid. Paste the secret shown when the key was generated, with no spaces.';

const siteUrl = z.string({ error: typeError({ invalid: URL_TEXT }) }).trim().max(MAX_URL_LENGTH, URL_TEXT)
    .superRefine((v, ctx) => {
        if (v === '') return;
        try {
            checkSiteUrl(v);
        } catch (err) {
            ctx.addIssue({ code: 'custom', message: err instanceof Error ? err.message : URL_TEXT });
        }
    })
    .nullable();

/** Text that passes `ok` unless it is '' (not set). */
const credential = (ok: (v: string) => boolean, message: string) => z.string({ error: typeError({ invalid: message }) })
    .trim().refine((v) => v === '' || ok(v), message).nullable();

export const frappeCrmFields = {
    frappeCrmUrl: siteUrl,
    frappeCrmApiKey: credential((v) => isValidCredential(v, { allowColon: false }), KEY_TEXT),
    frappeCrmApiSecret: credential((v) => isValidCredential(v), SECRET_TEXT),
};
