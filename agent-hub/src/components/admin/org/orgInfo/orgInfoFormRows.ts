// The rows of the organisation form: the fields it holds, the form values
// from a stored row, which fields each row (info, auth, licence, image limits)
// saves, and the PUT body for the fields of a row that changed. useOrgInfoForm
// drives the form; this file is its data.
import { imageLimitsToInput, parseImageLimitsInput } from '@/utils/imageLimits';
import type { ImageLimits, ImageLimitsInput } from '@/utils/imageLimits';

/**
 * The organisation's fields this form shows. A save sends only the fields of
 * the row being saved, and of those only the ones that changed (orgFormSaveBody):
 * fields edited elsewhere (auto-approve, default groups, sign-up) are not held
 * here at all, so a save of this form can never send them back stale.
 */
interface OrgFormFields {
    name: string;
    description: string;
    tagline: string;
    address: string;
    billingLine2: string;
    billingPostalCode: string;
    billingCity: string;
    billingCountry: string;
    email: string;
    phone: string;
    website: string;
    kvk: string;
    vat: string;
    /** Stored by its own upload and remove endpoints, never by the save. */
    logo: string;
    /** The preferred sign-in method: a preference, it can change at any time. */
    authMethod: string | null;
    usagePooled: boolean;
    allowedDomains: string[];
    /** The default image limits per user, as typed; empty = not set. Sent as numbers. */
    imageLimits: ImageLimitsInput;
}

/** The organisation's Nextcloud binding, as the Organisation info banner shows it. */
export interface OrgNcBinding {
    instanceId: string;
    baseUrl: string | null;
    adminUid: string | null;
    /** mirror_all, selective_groups or manual. */
    syncMode: string;
}

/** The organisation form as this page edits it. */
export interface OrgFormData extends OrgFormFields {
    id: string;
    /**
     * Read, never sent by the save: the auto-approve switch of the sign-in row
     * stores itself (AutoApproveSetting) and keeps this copy in step.
     */
    autoApproveSSO: boolean;
    /** Read only: the CHOSEN organisation's Nextcloud binding, null without one. */
    nc: OrgNcBinding | null;
}

/** One row of GET /auth/organizations, as far as the form reads it (the Nextcloud columns come as stored). */
export type OrgRow = Partial<Omit<OrgFormFields, 'imageLimits'>> & {
    id: string;
    imageLimits?: ImageLimits | null;
    autoApproveSSO?: boolean;
    nc_instance_id?: string | null;
    nc_base_url?: string | null;
    nc_admin_uid?: string | null;
    nc_sync_mode?: string | null;
};

/** The Nextcloud binding of a stored row, or null. */
function ncBindingOf(row: OrgRow): OrgNcBinding | null {
    if (!row.nc_instance_id) return null;
    return {
        instanceId: row.nc_instance_id,
        baseUrl: row.nc_base_url || null,
        adminUid: row.nc_admin_uid || null,
        syncMode: row.nc_sync_mode || 'mirror_all',
    };
}

/** The Organisation info row's text fields, in form order: empty when not set. */
const INFO_FIELDS = [
    'name', 'description', 'tagline', 'address', 'billingLine2', 'billingPostalCode', 'billingCity',
    'billingCountry', 'email', 'phone', 'website', 'kvk', 'vat',
] as const satisfies readonly (keyof OrgFormFields)[];

/** The form's starting values from the stored row. */
export function toFormData(myOrg: OrgRow): OrgFormData {
    const text = Object.fromEntries(INFO_FIELDS.map(f => [f, myOrg[f] || ''])) as Record<typeof INFO_FIELDS[number], string>;
    return {
        id: myOrg.id,
        ...text,
        logo: myOrg.logo || '',
        authMethod: myOrg.authMethod || null,
        // Default to pooled (true) when the column is null on
        // pre-migration orgs — matches the server-side default.
        usagePooled: myOrg.usagePooled === undefined ? true : !!myOrg.usagePooled,
        allowedDomains: Array.isArray(myOrg.allowedDomains) ? myOrg.allowedDomains : [],
        imageLimits: imageLimitsToInput(myOrg.imageLimits),
        autoApproveSSO: myOrg.autoApproveSSO === true,
        nc: ncBindingOf(myOrg),
    };
}

/** A field the save sends (the logo has its own endpoints). */
type OrgSavedField = Exclude<keyof OrgFormFields, 'logo'>;

const ALL_FIELDS: readonly OrgSavedField[] = [...INFO_FIELDS, 'authMethod', 'allowedDomains', 'usagePooled', 'imageLimits'];

/**
 * The fields a row of the organisation form edits, and so the only ones its
 * save sends. The image limits have one home in both modes: their card on the
 * Models page (imageLimits/OrgImageLimitsSection). An unknown or missing row
 * counts every field.
 */
export function orgFormRowFields(section: string | undefined): readonly OrgSavedField[] {
    switch (section) {
        case 'info': return INFO_FIELDS;
        case 'auth': return ['authMethod', 'allowedDomains'];
        case 'license': return ['usagePooled'];
        case 'image-limits': return ['imageLimits'];
        default: return ALL_FIELDS;
    }
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `fields` whose value in `current` differs from the stored one. */
export function changedOrgFields(current: OrgFormData, saved: OrgFormData, fields: readonly OrgSavedField[]): OrgSavedField[] {
    return fields.filter(f => !sameValue(current[f], saved[f]));
}

type OrgSaveBody = Partial<Omit<OrgFormFields, 'logo' | 'imageLimits'>> & { imageLimits?: ImageLimits | null };

/**
 * The PUT body for `changed`: those fields only, the image limits as whole
 * numbers (or null). undefined: an image limit is not a number, nothing is sent.
 */
export function orgFormSaveBody(current: OrgFormData, changed: readonly OrgSavedField[]): OrgSaveBody | undefined {
    const body: Record<string, unknown> = {};
    for (const f of changed) {
        if (f !== 'imageLimits') { body[f] = current[f]; continue; }
        const limits = parseImageLimitsInput(current.imageLimits);
        if (limits === undefined) return undefined;
        body.imageLimits = limits;
    }
    return body as OrgSaveBody;
}
