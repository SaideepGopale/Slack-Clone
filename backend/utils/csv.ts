interface CsvColumn {
  key: string;
  header: string;
}

const escapeCsvField = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  // Only needs quoting if it contains a comma, quote, or newline — quoting
  // everything unconditionally is also valid CSV but noisier to read raw.
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

export const toCsv = (rows: Record<string, unknown>[], columns: CsvColumn[]): string => {
  const headerLine = columns.map((c) => escapeCsvField(c.header)).join(',');
  const dataLines = rows.map((row) => columns.map((c) => escapeCsvField(row[c.key])).join(','));
  // CRLF per RFC 4180 — Excel in particular is picky about this on Windows.
  return [headerLine, ...dataLines].join('\r\n');
};
