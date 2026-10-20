// A small RFC 4180 reader for Seazona's CSV export: quoted fields, doubled
// quotes, commas and line breaks inside quotes, CRLF or LF, and a leading
// byte order mark. Answers { headers, rows }, each row an array of strings.
// Blank lines are skipped. It never evaluates a cell.

export class CsvError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message);
    this.code = 'csv_invalid';
    this.line = line ?? null;
  }
}

export function parseCsv(input) {
  const text = String(input ?? '').replace(/^﻿/, '');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line += 1;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push({ cells: record, line: startLine });
      record = [];
      field = '';
      line += 1;
      startLine = line;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new CsvError('A quoted field has no closing quote', startLine);
  if (field !== '' || record.length) {
    record.push(field);
    records.push({ cells: record, line: startLine });
  }
  const nonBlank = records.filter((r) => r.cells.some((cell) => cell.trim() !== ''));
  if (!nonBlank.length) throw new CsvError('The file has no header row');
  const [head, ...body] = nonBlank;
  const headers = head.cells.map((h) => h.trim());
  return { headers, rows: body.map((r) => ({ line: r.line, cells: r.cells })) };
}
