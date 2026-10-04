/** The automation as a file: its name, and what a picked file must be before it is sent. */

import { exportFileName, exportFileText, parseImportFile } from './transfer';

it('names the file after the automation, safely', () => {
    expect(exportFileName('Invoice reminders')).toBe('Invoice reminders.beeflow.json');
    expect(exportFileName('  Q3 / Q4: reports?  ')).toBe('Q3 Q4 reports.beeflow.json');
    expect(exportFileName('Überweisungen prüfen')).toBe('Überweisungen prüfen.beeflow.json');
    expect(exportFileName('')).toBe('Automation.beeflow.json');
    expect(exportFileName(null)).toBe('Automation.beeflow.json');
    expect(exportFileName('x'.repeat(200))).toHaveLength(80 + '.beeflow.json'.length);
});

it('reads an exported automation and refuses anything else', () => {
    expect(parseImportFile('﻿{"format":"beeflow.automation","automation":{}}')).toEqual({ ok: true, envelope: { format: 'beeflow.automation', automation: {} } });
    expect(parseImportFile('')).toEqual({ ok: false, reason: 'empty' });
    expect(parseImportFile('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(parseImportFile('{nope')).toEqual({ ok: false, reason: 'not_json' });
    expect(parseImportFile('[1,2]')).toEqual({ ok: false, reason: 'not_object' });
    expect(parseImportFile('null')).toEqual({ ok: false, reason: 'not_object' });
});

it('writes the envelope readably, and it reads back', () => {
    const envelope = { format: 'beeflow.automation', automation: { title: 'A' } };
    expect(exportFileText(envelope)).toBe(`${JSON.stringify(envelope, null, 2)}\n`);
    expect(parseImportFile(exportFileText(envelope))).toEqual({ ok: true, envelope });
});
