// The MCP library's recurring phrases, translated in one place so every card,
// drawer and wizard step says the same thing the same way.

import type { TranslateFn } from '../../hooks/useTranslation';
import { nOf } from '../admin/Studio/KnowledgeStudio/plural';
import { McpLibraryError } from '../../api/queries/mcpLibrary';
import type { McpAccess, RemoteMode } from '../../api/queries/mcpLibrary';

export function categoryLabel(t: TranslateFn, id: string): string {
    switch (id) {
        case 'development': return t('mcp_library.category.development', 'Development');
        case 'data': return t('mcp_library.category.data', 'Data');
        case 'docs': return t('mcp_library.category.docs', 'Documentation');
        case 'payments': return t('mcp_library.category.payments', 'Payments');
        case 'automation': return t('mcp_library.category.automation', 'Automation');
        case 'observability': return t('mcp_library.category.observability', 'Observability');
        default: return t('mcp_library.category.other', 'Other');
    }
}

export function policyLabel(t: TranslateFn, mode: RemoteMode): string {
    switch (mode) {
        case 'off': return t('mcp_library.policy.off', 'Switched off');
        case 'official': return t('mcp_library.policy.official', 'Official servers only');
        case 'allowlist': return t('mcp_library.policy.allowlist', 'Official servers and approved hosts');
        case 'any': return t('mcp_library.policy.any', 'Any public server');
        default: return mode;
    }
}

export function policyDescription(t: TranslateFn, mode: RemoteMode): string {
    switch (mode) {
        case 'off': return t('mcp_library.policy.off_desc', 'Organisation admins cannot add MCP servers, and servers they added earlier stop working.');
        case 'official': return t('mcp_library.policy.official_desc', 'Only the vendor-hosted servers in the Bee Flow library. Their addresses are fixed, so an admin cannot point agents somewhere else.');
        case 'allowlist': return t('mcp_library.policy.allowlist_desc', 'The official servers, plus servers on hosts you list below.');
        case 'any': return t('mcp_library.policy.any_desc', 'Any public https server an organisation admin enters. Private networks stay blocked.');
        default: return '';
    }
}

/** Why a server that is installed does not run under the current policy. */
export function blockedText(t: TranslateFn, reason: string | null): string {
    switch (reason) {
        case 'policy_off': return t('mcp_library.blocked.policy_off', 'Your server administrator has switched off MCP servers for organisations. This server is kept but does not run.');
        case 'not_official': return t('mcp_library.blocked.not_official', 'Your server administrator now allows official servers only. This server is kept but does not run.');
        case 'host_not_allowed': return t('mcp_library.blocked.host_not_allowed', 'This host is no longer on your server administrator\'s list. The server is kept but does not run.');
        default: return t('mcp_library.blocked.other', 'The server policy no longer allows this server. It is kept but does not run.');
    }
}

export function accessSummary(t: TranslateFn, access: McpAccess): string {
    if (access.mode === 'everyone') return t('mcp_library.access.everyone_short', 'Everyone');
    if (access.mode === 'groups') return nOf(t, 'mcp_library.access.n_groups', access.groupIds.length, '{count} group', '{count} groups');
    return t('mcp_library.access.nobody_short', 'Nobody yet');
}

export function toolCount(t: TranslateFn, count: number): string {
    return nOf(t, 'mcp_library.n_tools', count, '{count} tool', '{count} tools');
}

/**
 * A server failure as a sentence. Codes the library knows get their own
 * translated sentence; anything else shows what the server said, which is
 * already written for a person (see server/core/customIntegrations/mcpLibrary).
 */
export function errorText(t: TranslateFn, err: unknown): string {
    const code = err instanceof McpLibraryError ? err.code : null;
    switch (code) {
        case 'connect_timeout': return t('mcp_library.error.timeout', 'The server did not answer within 20 seconds.');
        case 'connect_blocked_address': return t('mcp_library.error.blocked_address', 'That address points to a private or internal network, which is never allowed.');
        case 'connect_unresolvable': return t('mcp_library.error.unresolvable', 'That host name does not exist.');
        case 'connect_not_https': return t('mcp_library.error.not_https', 'Only https addresses are allowed.');
        case 'connect_auth_failed': return t('mcp_library.error.auth_failed', 'The server refused the key. Check that it is correct and has the right permissions.');
        case 'connect_auth_required': return t('mcp_library.error.auth_required', 'This server only answers with a key. Add one and try again.');
        case 'connect_not_mcp': return t('mcp_library.error.not_mcp', 'There is no MCP server at that address.');
        case 'connect_redirect': return t('mcp_library.error.redirect', 'The server redirected the request, which is not followed for safety. Use the final address.');
        case 'connect_unreachable': return t('mcp_library.error.unreachable', 'The server could not be reached.');
        case 'policy_policy_off': return t('mcp_library.error.policy_off', 'Your server administrator has switched off installing MCP servers for organisations.');
        case 'policy_not_official': return t('mcp_library.error.policy_not_official', 'Only the official servers in the library can be installed on this server.');
        case 'policy_host_not_allowed': return t('mcp_library.error.policy_host_not_allowed', 'That host is not on the list your server administrator allows.');
        case 'feature_locked': return t('mcp_library.error.feature_locked', 'The MCP library is not part of your plan.');
        default: break;
    }
    if (err instanceof Error && err.message) return err.message;
    return t('mcp_library.error.generic', 'Something went wrong. Try again.');
}
