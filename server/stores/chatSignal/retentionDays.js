// @typecheck strict
'use strict';

/**
 * The compliance module's part of the chat signal retention (stores/chatSignalStore.js asks for
 * it by name, as a data duty): each organisation's own retention of chat-monitoring counts, set
 * in its compliance settings. Joined to the organisations `o` the purge walks; `days` is NULL
 * for an organisation without a setting (the purge then takes its default).
 */

const ORG_RETENTION = Object.freeze({
    join: 'LEFT JOIN compliance_settings s ON s.organization_id = o.organization_id',
    days: 's.chat_monitoring_retention_days',
});

module.exports = { ORG_RETENTION };
