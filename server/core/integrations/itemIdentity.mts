/**
 * Which key of an item an integration returned identifies it, when nothing
 * declared that: the poll_diff trigger runtime (automation/triggerSources)
 * and App Studio's connector-to-table detection (appStudio/connectorSchema)
 * ask the same question of the same responses, so both read this one list.
 */

/** Keys that plausibly identify one item, best first. */
export const ID_CANDIDATES: readonly string[] = [
    'id', 'uuid', 'guid', 'key', 'measurement_key', 'sku', 'resourceName', 'noteId', 'messageId',
    'threadId', 'eventId', 'fileId', 'deviceId', 'transcriptId', 'number', 'slug', 'path', 'url', 'name',
];
