/**
 * Microsoft 365. Delivered by Graph change notifications to a webhook, so
 * without a public base URL a subscription can never fire — which is why the
 * availability rule requires one rather than listing it dishonestly.
 *
 * Migrated verbatim from the hardcoded TRIGGER_PROVIDERS array and the
 * TRIGGER_FIELDS_BY_EVENT / TRIGGER_OUTPUT_SAMPLES maps. The catalog payload is
 * guarded byte-for-byte by triggerRegistry.golden.test.js.
 */
module.exports = { TRIGGER_SOURCES: [{
        id: 'msgraph',
        label: 'Microsoft 365 (Outlook)',
        order: 70,
        defaultEvent: 'mail.new',
        availability: {
            kind: 'tools',
            apps: ['outlook', 'ms-calendar', 'onedrive', 'outlook-readonly'],
            requiresPublicBaseUrl: true,
        },
        events: [
            {
                id: 'mail.new',
                label: 'New email (Outlook)',
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000001',
                    changeType: 'created',
                    resource: 'Users(\'user-guid\')/Messages(\'AAMkAGI2…\')',
                    resourceData: {
                        id: 'AAMkAGI2…',
                        '@odata.type': '#Microsoft.Graph.Message',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'mail.flagged',
                label: 'Email flagged',
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000002',
                    changeType: 'updated',
                    resource: 'Users(\'user-guid\')/Messages(\'AAMkAGI2…\')',
                    resourceData: {
                        id: 'AAMkAGI2…',
                        '@odata.type': '#Microsoft.Graph.Message',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'event.created',
                label: 'Calendar event created',
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000003',
                    changeType: 'created',
                    resource: 'Users(\'user-guid\')/Events(\'AAMkAGI2…\')',
                    resourceData: {
                        id: 'AAMkAGI2…',
                        '@odata.type': '#Microsoft.Graph.Event',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'event.changed',
                label: 'Calendar event changed',
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000004',
                    changeType: 'updated',
                    resource: 'Users(\'user-guid\')/Events(\'AAMkAGI2…\')',
                    resourceData: {
                        id: 'AAMkAGI2…',
                        '@odata.type': '#Microsoft.Graph.Event',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'file.new',
                label: 'New OneDrive file',
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000006',
                    changeType: 'created',
                    resource: 'Users(\'user-guid\')/Drive/Root',
                    resourceData: {
                        id: '01BYE5RZ…',
                        '@odata.type': '#Microsoft.Graph.DriveItem',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'file.changed',
                label: 'OneDrive file changed',
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000007',
                    changeType: 'updated',
                    resource: 'Users(\'user-guid\')/Drive/Root',
                    resourceData: {
                        id: '01BYE5RZ…',
                        '@odata.type': '#Microsoft.Graph.DriveItem',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
            {
                id: 'event.updated',
                label: 'event.updated',
                hidden: true,
                fields: ['subscriptionId', 'changeType', 'resource', 'resourceData'],
                sample: {
                    subscriptionId: 'a1b2c3d4-0000-0000-0000-000000000005',
                    changeType: 'updated',
                    resource: 'Users(\'user-guid\')/Events(\'AAMkAGI2…\')',
                    resourceData: {
                        id: 'AAMkAGI2…',
                        '@odata.type': '#Microsoft.Graph.Event',
                    },
                },
                scope: 'user',
                source: {
                    kind: 'push',
                },
            },
        ],
    }] };
