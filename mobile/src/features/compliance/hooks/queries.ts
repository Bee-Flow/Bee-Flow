/**
 * The hub's reads. Each takes `enabled` so nothing is asked of the server
 * before the gate has opened (the server would 403, and a locked screen must
 * not flash an error first).
 */

import { useQuery } from '@tanstack/react-query';

import {
    fetchChoices,
    fetchRaw,
    fetchRecordDetail,
    fetchRecords,
    getAccessAudit,
    getAccessAuditActions,
    getAttention,
    getCheckEvidence,
    getCheckHistory,
    getChecks,
    getCounts,
    getDeadlines,
    getFrameworks,
    getOrgUsers,
    getPortability,
    getRopa,
    getSettings,
} from '../api/endpoints';
import { complianceKeys } from '../api/keys';
import type { RecordType } from '../model/types';

export const useCounts = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.counts(), queryFn: ({ signal }) => getCounts(signal), enabled, staleTime: 30_000 });

export const useAttention = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.attention(), queryFn: ({ signal }) => getAttention(signal), enabled });

export const useDeadlines = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.deadlines(), queryFn: ({ signal }) => getDeadlines(signal), enabled });

export const useFrameworks = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.frameworks(), queryFn: ({ signal }) => getFrameworks(signal), enabled });

export const useOrgUsers = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.orgUsers(), queryFn: ({ signal }) => getOrgUsers(signal), enabled, staleTime: 5 * 60_000 });

export const useChecks = (framework: string | null, enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.checks(framework), queryFn: ({ signal }) => getChecks(framework, signal), enabled });

export const useCheckHistory = (checkId: string, enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.checkHistory(checkId), queryFn: ({ signal }) => getCheckHistory(checkId, signal), enabled });

export const useCheckEvidence = (checkId: string, enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.checkEvidence(checkId), queryFn: ({ signal }) => getCheckEvidence(checkId, signal), enabled });

export const useComplianceSettings = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.settings(), queryFn: ({ signal }) => getSettings(signal), enabled });

export const useRopa = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.ropa(), queryFn: ({ signal }) => getRopa(signal), enabled });

export const usePortability = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.portability(), queryFn: ({ signal }) => getPortability(signal), enabled });

export const useAccessAudit = (action: string | null, offset: number, enabled: boolean) =>
    useQuery({
        queryKey: complianceKeys.accessAudit(action, offset),
        queryFn: ({ signal }) => getAccessAudit({ action: action ?? undefined }, offset, signal),
        enabled,
    });

export const useAccessAuditActions = (enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.accessAuditActions(), queryFn: ({ signal }) => getAccessAuditActions(signal), enabled });

export const useRecords = (type: RecordType | null, enabled: boolean) =>
    useQuery({
        queryKey: complianceKeys.records(type?.id ?? ''),
        queryFn: ({ signal }) => fetchRecords(type as RecordType, signal),
        enabled: enabled && type !== null,
    });

export const useRecordDetail = (type: RecordType | null, id: string, enabled: boolean) =>
    useQuery({
        queryKey: complianceKeys.recordDetail(type?.id ?? '', id),
        queryFn: ({ signal }) => fetchRecordDetail(type as RecordType, id, signal),
        enabled: enabled && Boolean(type?.detail),
    });

export const useRaw = (path: string | null, enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.raw(path ?? ''), queryFn: ({ signal }) => fetchRaw(path as string, signal), enabled: enabled && path !== null });

export const useRemoteChoices = (path: string | null, enabled: boolean) =>
    useQuery({ queryKey: complianceKeys.choices(path ?? ''), queryFn: ({ signal }) => fetchChoices(path as string, signal), enabled: enabled && path !== null });
