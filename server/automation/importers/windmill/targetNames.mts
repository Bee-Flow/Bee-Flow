/**
 * The Bee Flow names the Windmill converter maps TO that other work packages
 * of the same round add (PLAN A1-A9): new Nextcloud tools, new trigger events,
 * the webhook `header_token` mode, the approval `on_expired` edge and the
 * attachment parameter of `nextcloud_mail_send`.
 *
 * They live in this one module so an integrator who lands those packages
 * under a different name changes one line here, and nothing else in the
 * converter spells them. Every other target name the converter writes already
 * exists in the product (the Nextcloud tool catalogue, the trigger catalogue,
 * the edge labels).
 */

/** Tools added by A3, A6, A9 and A4. */
export const TOOL = Object.freeze({
    /** A3: a file's path, name and size from its numeric id. */
    fileInfo: 'nextcloud_file_info',
    /** A3: a user's profile (display name, e-mail, manager). */
    getUser: 'nextcloud_get_user',
    /** A6: one generic OCS/DAV request on an allow-list. */
    request: 'nextcloud_request',
    /** A9: `nextcloud_read_file` reads the AcroForm values with this flag. */
    readFile: 'nextcloud_read_file',
    mailSend: 'nextcloud_mail_send',
});

/** A9: the input of `nextcloud_read_file` that asks for the PDF form fields. */
export const READ_FILE_FORM_FIELDS_PARAM = 'formFields';

/** A10: the output field of `nextcloud_read_file` that names an image it read. */
export const READ_FILE_IMAGE_HANDLE_FIELD = 'sourceHandle';

/** A10: the field of an `ai_step` that lists the images it shows the model. */
export const AI_STEP_IMAGES_FIELD = 'images';

/** A4: the input of `nextcloud_mail_send` that carries attachments. */
export const MAIL_ATTACHMENTS_PARAM = 'attachments';

/** A3: the output field of `nextcloud_file_info` that holds the path. */
export const FILE_INFO_PATH_FIELD = 'path';

/** A3: the output field of `nextcloud_get_user` that holds the manager's uid. */
export const GET_USER_MANAGER_FIELD = 'manager';

/** A1 and A5: Nextcloud trigger events that become selectable in this round. */
export const NEW_NEXTCLOUD_EVENTS = Object.freeze({
    fileCopied: 'file.copied',
    fileRestored: 'file.restored',
    fileUntagged: 'file.untagged',
    tableRowDeleted: 'tables.row.deleted',
    calendarMoved: 'calendar.event.moved',
    calendarDeleted: 'calendar.event.deleted',
    mailNew: 'mail.new',
});

/** A7: the webhook trigger's authentication mode for callers that cannot sign. */
export const WEBHOOK_HEADER_TOKEN_AUTH = 'header_token';

/** A8: the approval edge taken when the deadline passes. */
export const APPROVAL_EXPIRED_EDGE = 'on_expired';
