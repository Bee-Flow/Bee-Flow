/**
 * What a writeTo mapping may name, per step kind whose outputs are FIXED (there is no schema to
 * map from). Copies of server/appStudio/validate/stepDataChecks.js FILE_INTAKE_OUTPUTS and
 * DATASET_QUERY_OUTPUTS; writeToOutputs.lockstep.test.ts keeps them equal.
 */
export const FIXED_WRITE_OUTPUTS: Record<string, readonly string[]> = {
    file_intake: [
        'base_name', 'cad_name', 'cad_file', 'drawing_name', 'drawing_file', 'role', 'file_name', 'match_status',
        'part_key', 'operation', 'folder', 'extra_cad',
    ],
    dataset_query: [
        'chrom', 'pos', 'id', 'ref', 'alt', 'qual', 'filter', 'info', 'variant_key', 'gene', 'region',
    ],
};
