// @typecheck strict
'use strict';

// The complete set of SOAP methods this module may ever call, as `Service/Method`
// — all read-only. Belt-and-suspenders: soapRequest() refuses any pair not in
// this set, so no mutation method can be reached even by a future bug. Keyed by
// service because the same method name (List_GetAll) exists in several services.
// Names checked against the v3 WSDLs (api.nmbrs.nl/soap/v3/<Service>.asmx?WSDL).
const SOAP_METHODS_READONLY = new Set([
    'DebtorService/List_GetAll',
    'CompanyService/List_GetAll',
    'CompanyService/List_GetByDebtor',
    'EmployeeService/List_GetByCompany',
    'EmployeeService/PersonalInfo_GetCurrent',
    'EmployeeService/Contract_GetAll',
    'EmployeeService/Salary_GetList',
    'EmployeeService/WageComponentFixed_Get',
    'EmployeeService/WageComponentVar_Get',
    'EmployeeService/Employment_GetAll_AllEmployeesByCompany',
    'EmployeeService/LeaseCar_GetAll_EmployeesByCompany',
    'EmployeeService/SVW_GetAll_AllEmployeesByCompany',
    'EmployeeService/PersonalInfoContractSalaryAddress_GetAll_AllEmployeesByCompany',
    'EmployeeService/Contract_GetAll_AllEmployeesByCompany',
    'CompanyService/Run_GetList',
]);

// EmployeeService/List_GetByCompany filters on Nmbrs' EmployeeType enumeration:
// 2 = payroll employee (in service), 4 = former payroll employee. "All" is both.
const EMPLOYEE_TYPE_PAYROLL = 2;
const EMPLOYEE_TYPE_FORMER_PAYROLL = 4;

module.exports = { SOAP_METHODS_READONLY, EMPLOYEE_TYPE_PAYROLL, EMPLOYEE_TYPE_FORMER_PAYROLL };
