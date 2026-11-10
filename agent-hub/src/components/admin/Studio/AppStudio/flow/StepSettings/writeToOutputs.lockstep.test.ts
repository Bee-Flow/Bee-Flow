import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { FIXED_WRITE_OUTPUTS } from './writeToOutputs';

const require = createRequire(import.meta.url);
const { FILE_INTAKE_OUTPUTS, DATASET_QUERY_OUTPUTS } = require('../../../../../../../../server/appStudio/validate/stepDataChecks.js');

describe('the fixed writeTo outputs the step editor offers are the ones the server accepts', () => {
    it('file_intake', () => expect(FIXED_WRITE_OUTPUTS.file_intake).toEqual(FILE_INTAKE_OUTPUTS));
    it('dataset_query', () => expect(FIXED_WRITE_OUTPUTS.dataset_query).toEqual(DATASET_QUERY_OUTPUTS));
});
