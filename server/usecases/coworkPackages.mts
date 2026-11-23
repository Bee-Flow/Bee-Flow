/**
 * A cowork as a signed package (Cowork 3.2): a template of the caller's organisation (./coworkTemplates.mts) written
 * out as one file, signed with the installation's Ed25519 key (core/cowork/receipts/receiptKey.mts), and read back in
 * on this or another installation.
 *
 * Reading a package in never trusts what it says about itself:
 *
 *   - the signature must hold over its content, with the public key it names; a package changed after it was signed
 *     is refused. The key says WHICH installation signed it; whether that installation is trusted is the reader's
 *     call, and the preview says plainly whether it was this one;
 *   - its plan must have the fingerprint it was saved with, and what it may do is worked out again from the plan
 *     itself (templatePlanOf), never read from the file;
 *   - adding it makes a paused item with the plan unapproved (startFrom): its owner tries it on their own data and
 *     approves it like any plan. Nothing runs.
 *
 * A Hub listing would add its own co-signature next to the installation's; the field is there, and empty.
 */

import { createRequire } from 'node:module';
import { canonicalJson } from '../core/cowork/receipts/receiptHash.mts';
import { keyIdOf, receiptKey, type ReceiptKey } from '../core/cowork/receipts/receiptKey.mts';
import { createPublicKey, sign, verify, createPrivateKey } from 'node:crypto';
import { defaultDeps, startFrom, templatePlanOf, type TemplateDeps, type TemplatePlan, type UsedTemplate } from './coworkTemplates.mts';
import type { CoworkTemplate } from '../stores/coworkTemplates.mts';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../core/http/errors.js') as { HttpError: new (status: number, code: string, message: string) => Error };

export const PACKAGE_FORMAT = 'beeflow.cowork-package';
export const PACKAGE_VERSION = 1;
const MAX_TEXT = 20_000;

/** What a package carries and what its signature covers. */
export interface PackageContent {
    format: typeof PACKAGE_FORMAT;
    v: typeof PACKAGE_VERSION;
    title: string;
    brief: string;
    repeatInterval: string | null;
    definition: Record<string, unknown> | null;
    fingerprint: string | null;
    issuedAt: string;
}

export interface CoworkPackage extends PackageContent {
    signature: { algorithm: 'Ed25519'; keyId: string; publicKeyPem: string; value: string };
    /** A Hub listing's own signature over the same content; null until such a listing exists. */
    hubSignature: null;
}

export interface PackageDeps extends TemplateDeps {
    signingKey: () => Promise<ReceiptKey | null>;
}

const refuse = (status: number, message: string) => new HttpError(status, 'cowork_package_refused', message);
const packageDeps = (): PackageDeps => ({ ...defaultDeps(), signingKey: () => receiptKey() });

/** The bytes a package's signature covers: its content as canonical JSON. */
function signedBytes(content: PackageContent): Buffer {
    return Buffer.from(canonicalJson(content), 'utf8');
}

/** A template of the caller's organisation as a signed package. */
export async function packageOf(userId: string, templateId: string, deps: PackageDeps = packageDeps(), now: Date = new Date()): Promise<CoworkPackage> {
    const user = await deps.getUser(userId);
    const orgId = user?.organizationId ? String(user.organizationId) : null;
    const template = orgId ? await deps.templates.get(templateId, orgId) : null;
    if (!orgId || !template) throw refuse(404, 'That template does not exist.');
    const key = await deps.signingKey();
    if (!key) throw refuse(409, 'This installation has no signing key (no MASTER_ENCRYPTION_KEY), so it cannot sign a package.');
    const content: PackageContent = {
        format: PACKAGE_FORMAT, v: PACKAGE_VERSION, title: template.title, brief: template.brief,
        repeatInterval: template.repeatInterval, definition: template.definition, fingerprint: template.fingerprint, issuedAt: now.toISOString(),
    };
    const value = sign(null, signedBytes(content), createPrivateKey(key.privateKeyPem)).toString('base64url');
    return { ...content, signature: { algorithm: 'Ed25519', keyId: key.keyId, publicKeyPem: key.publicKeyPem, value }, hubSignature: null };
}

const str = (v: unknown, max = MAX_TEXT): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** The content of a file that claims to be a package, or the reason it is not one. Reads only known fields. */
function contentOf(file: unknown): { content: PackageContent; signature: CoworkPackage['signature'] } {
    if (!isObj(file) || file.format !== PACKAGE_FORMAT || file.v !== PACKAGE_VERSION) throw refuse(422, 'This is not a Cowork package this version can read.');
    const sig = isObj(file.signature) ? file.signature : null;
    const title = str(file.title, 200);
    const brief = str(file.brief);
    const issuedAt = str(file.issuedAt, 40);
    if (!title || brief === null || !issuedAt || !sig || sig.algorithm !== 'Ed25519' || !str(sig.publicKeyPem, 1000) || !str(sig.value, 200) || !str(sig.keyId, 64)) {
        throw refuse(422, 'This package is incomplete.');
    }
    const content: PackageContent = {
        format: PACKAGE_FORMAT, v: PACKAGE_VERSION, title, brief,
        repeatInterval: str(file.repeatInterval, 40), definition: isObj(file.definition) ? file.definition : null,
        fingerprint: str(file.fingerprint, 128), issuedAt,
    };
    return { content, signature: sig as CoworkPackage['signature'] };
}

/** Does the signature hold over this content with the key it names, and does the key id match that key? */
function signatureHolds(content: PackageContent, signature: CoworkPackage['signature']): boolean {
    try {
        if (keyIdOf(signature.publicKeyPem) !== signature.keyId) return false;
        return verify(null, signedBytes(content), createPublicKey(signature.publicKeyPem), Buffer.from(signature.value, 'base64url'));
    } catch {
        return false;
    }
}

export interface PackagePreview {
    title: string;
    brief: string;
    repeatInterval: string | null;
    plan: TemplatePlan | null;
    signedBy: { keyId: string; thisInstallation: boolean };
}

/** Read a package: refused when its signature does not hold; what its plan may do is worked out again. */
export async function previewPackage(file: unknown, deps: PackageDeps = packageDeps()): Promise<{ preview: PackagePreview; template: CoworkTemplate }> {
    const { content, signature } = contentOf(file);
    if (!signatureHolds(content, signature)) throw refuse(422, 'The signature of this package does not hold: it was changed after it was signed, or it was never signed. It is not added.');
    const own = await deps.signingKey();
    const template: CoworkTemplate = {
        id: `package:${signature.keyId}`, organizationId: '', createdBy: null, title: content.title, brief: content.brief,
        repeatInterval: content.repeatInterval, definition: content.definition, fingerprint: content.fingerprint, createdAt: content.issuedAt,
    };
    return {
        template,
        preview: {
            title: content.title, brief: content.brief, repeatInterval: content.repeatInterval,
            plan: templatePlanOf(template, deps.lookups),
            signedBy: { keyId: signature.keyId, thisInstallation: !!own && own.keyId === signature.keyId },
        },
    };
}

/** Add a package as a new, paused item of the caller's, with its plan unapproved when it has no findings. */
export async function addPackage(userId: string, file: unknown, deps: PackageDeps = packageDeps()): Promise<UsedTemplate> {
    const { template } = await previewPackage(file, deps);
    const user = await deps.getUser(userId);
    const orgId = user?.organizationId ? String(user.organizationId) : null;
    if (!orgId) throw refuse(409, 'A package is added within an organisation.');
    return startFrom(userId, orgId, { ...template, organizationId: orgId }, deps);
}
