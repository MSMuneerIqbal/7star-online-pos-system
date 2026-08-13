/**
 * Excel export for reports — the shape the old apps already produced: a summary
 * block at the top, coloured column headers, and only what the filter shows.
 */
import ExcelJS from 'exceljs';

export interface ReportColumn {
  header: string;
  /** Key into the row object. */
  key: string;
}

export interface ReportSummary {
  label: string;
  value: string;
}

/**
 * Build an .xlsx from a title, a summary block and the filtered rows.
 */
export async function buildReportWorkbook(opts: {
  title: string;
  summary: ReportSummary[];
  columns: ReportColumn[];
  rows: ReadonlyArray<unknown>;
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');

  ws.addRow([opts.title]);
  ws.getRow(1).font = { bold: true, size: 14 };

  for (const s of opts.summary) {
    ws.addRow([s.label, s.value]);
  }
  ws.addRow([]);

  const headerRow = ws.addRow(opts.columns.map((c) => c.header));
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF346DD7' } };
  });

  for (const raw of opts.rows) {
    const row = raw as Record<string, unknown>;
    ws.addRow(opts.columns.map((c) => row[c.key] ?? ''));
  }

  ws.columns.forEach((col, i) => {
    const header = opts.columns[i]?.header ?? '';
    col.width = Math.max(14, header.length + 4);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
