'use strict';

/**
 * Tool definitions in OpenAI function-calling format. All read-only.
 */

const { PAGING_PROPS } = require('./nmbrsPaging');

const NMBRS_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_debtors',
            description: 'List the NMBRS debtors (top-level payroll administrations) your account can access. Read-only. Call this first to find debtorId values. Works the same whether the connection uses the NMBRS SOAP or REST API.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_companies',
            description: 'List NMBRS companies (employers), optionally restricted to one debtor. Read-only. Returns company IDs needed by nmbrs_list_employees.',
            parameters: {
                type: 'object',
                properties: {
                    debtorId: { type: 'string', description: 'Optional debtor ID from nmbrs_list_debtors to filter companies.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employees',
            description: 'List employees of an NMBRS company (read-only), one page at a time: the result has total, hasMore and nextOffset. Use companyId from nmbrs_list_companies. Returns employee IDs for the per-employee tools.',
            parameters: {
                type: 'object',
                properties: {
                    companyId: { type: 'string', description: 'Company ID from nmbrs_list_companies.' },
                    activeOnly: { type: 'boolean', description: 'When true (default), only currently-employed staff are returned.' },
                    ...PAGING_PROPS
                },
                required: ['companyId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_get_employee',
            description: 'Get core NMBRS details for one employee: name, employee number, and current personal/employment info (read-only). Use employeeId from nmbrs_list_employees.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' }
                },
                required: ['employeeId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employee_contracts',
            description: 'List the contract history for one NMBRS employee: start/end dates, weekly hours, contract type (read-only).',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' }
                },
                required: ['employeeId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employee_salaries',
            description: 'List the salary records of one NMBRS employee that apply in a given year and period (month): gross amount, salary type, effective date (read-only). NMBRS needs both year and period. Payroll data is sensitive — only retrieve what the user asked for.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' },
                    year: { type: 'integer', description: 'Calendar year, e.g. 2026.' },
                    period: { type: 'integer', description: 'Period/month, 1-13.' }
                },
                required: ['employeeId', 'year', 'period']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_employee_wage_components',
            description: 'List fixed and variable wage components for one NMBRS employee in a given year (and a period/month: required over the NMBRS SOAP API, optional over REST). Read-only. Payroll data is sensitive — only retrieve what was asked.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' },
                    year: { type: 'integer', description: 'Calendar year, e.g. 2026.' },
                    period: { type: 'integer', description: 'Period/month, 1-13. Required over SOAP; over REST omit it for the whole year.' }
                },
                required: ['employeeId', 'year']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nmbrs_list_payslips',
            description: 'List payslip / payrun summaries for one NMBRS employee in a given year (and optionally a period/month). Read-only — returns metadata and totals, not the binary PDF.',
            parameters: {
                type: 'object',
                properties: {
                    employeeId: { type: 'string', description: 'Employee ID from nmbrs_list_employees.' },
                    year: { type: 'integer', description: 'Calendar year, e.g. 2026.' },
                    period: { type: 'integer', description: 'Optional 1-based period/month (1-13). Omit for the whole year.' }
                },
                required: ['employeeId', 'year']
            }
        }
    }
];

module.exports = { NMBRS_TOOLS };
