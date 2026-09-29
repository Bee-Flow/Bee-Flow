/**
 * Google Drive. Hand-written poller in triggerBus.js (changes.list against a
 * start page token).
 *
 * Migrated verbatim from the hardcoded TRIGGER_PROVIDERS array and the
 * TRIGGER_FIELDS_BY_EVENT / TRIGGER_OUTPUT_SAMPLES maps. The catalog payload is
 * guarded byte-for-byte by triggerRegistry.golden.test.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'google-drive',
        label: 'Google Drive',
        order: 30,
        defaultEvent: 'file.new',
        availability: {
            kind: 'tools',
            apps: ['google-drive'],
        },
        events: [
            {
                id: 'file.new',
                label: 'New file',
                fields: ['fileId', 'name', 'mimeType', 'parents', 'createdTime', 'owners', 'webViewLink'],
                sample: {
                    fileId: 'file-xyz',
                    name: 'Invoice-2026-001.pdf',
                    mimeType: 'application/pdf',
                    parents: ['folder-abc'],
                    createdTime: '2026-05-13T09:15:00Z',
                    owners: [
                        {
                            emailAddress: 'me@example.com',
                            displayName: 'Me',
                        },
                    ],
                    webViewLink: 'https://drive.google.com/file/d/file-xyz',
                },
                scope: 'user',
                source: {
                    kind: 'poller',
                },
            },
        ],
    }] };
