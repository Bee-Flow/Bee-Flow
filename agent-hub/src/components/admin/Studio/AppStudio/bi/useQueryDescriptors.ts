import { useMemo } from 'react';
import { applyParamRows, paramProblems, type ParamRow } from './datasetParamRows';
import { withSortLimit, type DatasetSort } from './datasetShape';
import type { TableColumn } from '../inspector/aiFieldMatching';

type Built<D> = { descriptor: D; valid: boolean };
type DescriptorBase = { filters?: unknown[]; groupBy?: Array<{ field?: string; bucket?: string; as?: string } | null>; aggregates?: Array<{ as?: string } | null>; [key: string]: unknown };

/**
 * The dataset builder's two descriptors: the one it saves and the one its live
 * preview runs. Parameter rows become declarations plus `{ param }` clauses in
 * the saved one; the preview runs each parameter at its default, since it has
 * no binding to send values. Sort and limit ride on both. Without parameter
 * rows, sort and limit, both are the built descriptor with exactly its keys.
 */
export function useQueryDescriptors<D extends DescriptorBase>(
    built: Built<D>,
    paramRows: ParamRow[],
    fields: TableColumn[],
    sort: DatasetSort | null,
    limit: number | null,
) {
    const paramsOk = useMemo(() => Object.keys(paramProblems(paramRows, fields)).length === 0, [paramRows, fields]);
    const withParams = useMemo(
        () => applyParamRows(built.descriptor, paramsOk ? paramRows : [], fields),
        [built.descriptor, paramRows, paramsOk, fields],
    );
    const descriptor = useMemo(() => withSortLimit(withParams.saved, sort, limit), [withParams.saved, sort, limit]);
    const previewDescriptor = useMemo(() => withSortLimit(withParams.preview, sort, limit), [withParams.preview, sort, limit]);
    return { descriptor, previewDescriptor, valid: built.valid && paramsOk };
}
