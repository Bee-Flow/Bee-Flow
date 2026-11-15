/**
 * Which of this round's new Bee Flow building blocks the converter may map to
 * (targetNames.mts). All on by default: they land together with the importer.
 * A caller on an installation without one of them passes it as false, and
 * the converter then makes an AI checklist item (or a warning) instead of
 * writing a name the validator would not know.
 */

export interface Capabilities {
    /** `nextcloud_file_info` (A3). */
    fileInfo: boolean;
    /** `nextcloud_get_user` (A3). */
    getUser: boolean;
    /** `nextcloud_request` (A6). */
    request: boolean;
    /** `nextcloud_read_file` with `formFields` (A9). */
    readFileFormFields: boolean;
    /** Attachments on `nextcloud_mail_send` (A4). */
    mailAttachments: boolean;
    /** The approval `on_expired` edge (A8). */
    onExpiredEdge: boolean;
    /** Code steps (isolated-vm installed; automation/codeSandbox.js isAvailable()). */
    codeStep: boolean;
}

export const ALL_CAPABILITIES: Readonly<Capabilities> = Object.freeze({
    fileInfo: true, getUser: true, request: true, readFileFormFields: true, mailAttachments: true, onExpiredEdge: true, codeStep: true,
});

export function capabilitiesFrom(partial: Partial<Capabilities> | undefined): Capabilities {
    return { ...ALL_CAPABILITIES, ...(partial ?? {}) };
}
