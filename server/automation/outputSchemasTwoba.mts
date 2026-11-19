/**
 * Output schemas of the 2BA tools (integrations/twobaTools.mts), merged into
 * OUTPUT_SCHEMAS by ./outputSchemas.js: what the builder may bind to, and the
 * dry-run placeholder of the upload (a side effect, never called in a dry run).
 * Checked against the executors' return values; change both together.
 */

const PRICE = 'object { grossPriceInPriceUnit, netPriceInPriceUnit, netPriceInOrderUnit, netPricePerUseUnit, netPriceOnMinimumQuantity, discountPercentage, conditionId, scenario (1-7), scenarioName, termsType (AC|BC|PC) } or null';
const TRADE_ITEM = 'object { id, tradeItemId, gtin, description, supplierGln, statusCode, successorTradeItemCode, successorGtin, useUnit { code, description }, orderUnit { code, description }, priceUnit { code, description }, '
    + 'numberOfUnitsInPriceBasis, priceToOrderUnitFactor, quantityOfUseUnits, minimumOrderQuantity, orderMultiple, packageTypeCode, packageTypeDescription, priceOnRequestIndicator, startDatePriceInformation, vatPercentage, currencyCode } or null';

const sampleItem = {
    id: 123456789, tradeItemId: 'K-100', gtin: '08712345678906', description: 'Cable 3x2.5', supplierGln: '8711389000001',
    statusCode: '126', successorTradeItemCode: null, successorGtin: null,
    useUnit: { code: 'MTR', description: 'meter' }, orderUnit: { code: 'RO', description: 'rol' }, priceUnit: { code: 'MTR', description: 'meter' },
    numberOfUnitsInPriceBasis: 100, priceToOrderUnitFactor: 1, quantityOfUseUnits: 100, minimumOrderQuantity: 1, orderMultiple: 1,
    packageTypeCode: 'RO', packageTypeDescription: 'Rol', priceOnRequestIndicator: false, startDatePriceInformation: '2026-01-01T00:00:00.000Z',
    vatPercentage: 21, currencyCode: 'EUR',
};
const samplePrice = {
    grossPriceInPriceUnit: 200, netPriceInPriceUnit: 125.5, netPriceInOrderUnit: 125.5, netPricePerUseUnit: 1.255, netPriceOnMinimumQuantity: 125.5,
    discountPercentage: 37.25, conditionId: 501, scenario: 3, scenarioName: 'DiscountGroupPercentage', termsType: 'BC',
};

export const OUTPUT_SCHEMAS_TWOBA: Record<string, { shape: Record<string, string>; sample: unknown; echo?: Record<string, string> }> = {
    twoba_find_trade_items: {
        shape: {
            supplierGln: 'string (13 digits)',
            projectNumber: 'string or null',
            priceDate: 'string (YYYY-MM-DD, the day the prices were asked)',
            items: `array of { ref, status (matched|not_found|multiple|code_mismatch), input { tradeItemId, gtin, quantity, unit }, tradeItem ${TRADE_ITEM}, price ${PRICE}, `
                + 'unitNetPrice (per use unit) or null, quantity, lineTotalExVat (rounded to cents) or null, currency, priceDate, flags (array of string), candidates (array, only for multiple / code_mismatch), '
                + 'and flat copies for a table: articleNumber, description, conditionId, scenarioName, termsType, review (the status when not matched and the flags as one text, null when the line needs no look) }',
            summary: 'object { items, byStatus { matched, not_found, multiple, code_mismatch }, byFlag { <flag>: count }, pricedLines, linesNeedingReview, totalExVat, currency }',
        },
        sample: {
            supplierGln: '8711389000001', projectNumber: null, priceDate: '2026-11-19',
            items: [{
                ref: '1', status: 'matched', input: { tradeItemId: 'K-100', gtin: null, quantity: 30, unit: 'm' }, tradeItem: sampleItem, price: samplePrice,
                unitNetPrice: 1.255, quantity: 30, lineTotalExVat: 37.65, currency: 'EUR', priceDate: '2026-11-19', flags: [],
                articleNumber: 'K-100', description: 'Cable 3x2.5', conditionId: 501, scenarioName: 'DiscountGroupPercentage', termsType: 'BC', review: null,
            }],
            summary: { items: 1, byStatus: { matched: 1, not_found: 0, multiple: 0, code_mismatch: 0 }, byFlag: {}, pricedLines: 1, linesNeedingReview: 0, totalExVat: 37.65, currency: 'EUR' },
        },
    },
    twoba_net_price: {
        shape: {
            status: 'string (matched|not_found|multiple)', supplierGln: 'string', tradeItemId: 'string', gtin: 'string or null',
            projectNumber: 'string or null', orderQuantity: 'number or null', tradeItem: `${TRADE_ITEM} (only when found by GTIN)`,
            price: PRICE, unitNetPrice: 'number or null (per use unit)', priceDate: 'string (YYYY-MM-DD)', flags: 'array of string',
        },
        sample: {
            status: 'matched', supplierGln: '8711389000001', tradeItemId: 'K-100', gtin: null, projectNumber: null, orderQuantity: null,
            price: samplePrice, unitNetPrice: 1.255, priceDate: '2026-11-19', flags: [],
        },
    },
    twoba_list_condition_databases: {
        shape: {
            databases: 'array of { id, name, createDate }',
            current: 'object { companyName, databaseName } (the database prices come from)',
        },
        sample: { databases: [{ id: 3, name: 'Main', createDate: '2026-01-01T00:00:00.000Z' }], current: { companyName: 'Example Company BV', databaseName: 'Main' } },
    },
    twoba_upload_conditions: {
        shape: {
            ok: 'boolean (every file imported without an error)', databaseId: 'integer', process: 'string (DoNotProcess|ProcessIfAllOk|ProcessAlways)',
            filename: 'string', size: 'integer (bytes)', sha256: 'string (hex, of the file sent: record it to know which condition file version was used)',
            uploadedAt: 'string (ISO date-time)', files: 'array of { importId, name, size, error }',
            importResult: 'object { id, filename, formatName, importDate, processingDate, totalImportRows, totalImportRowsFailure, importDetailsLink } (only when 2BA answers with one)',
        },
        sample: {
            ok: true, databaseId: 3, process: 'DoNotProcess', filename: 'conditions.icc', size: 48213,
            sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', uploadedAt: '2026-11-19T09:00:00.000Z',
            files: [{ importId: 77, name: 'conditions.icc', size: 48213, error: null }],
        },
        echo: { databaseId: 'databaseId', process: 'process' },
    },
};
