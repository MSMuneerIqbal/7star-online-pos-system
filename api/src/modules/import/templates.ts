/**
 * Sample templates — a blank spreadsheet with the expected column headers and
 * one example row, so the operator knows how to fill an import file.
 *
 * Raw items round-trip: the `raw-item` headers are the exact ones
 * `service.ts` parses. The other entities have no import yet, so their
 * templates are the natural columns their forms carry — the same machinery
 * Phase 11 will import from.
 */
import ExcelJS from 'exceljs';

export interface Template {
  fileName: string;
  headers: string[];
  example: Array<string | number>;
}

export const TEMPLATES: Record<string, Template> = {
  brand: {
    fileName: 'brand-template.xlsx',
    headers: ['Name', 'Other Name', 'Raw Material Brand'],
    example: ['Samsung', 'Samsung SDI', 'NO'],
  },
  category: {
    fileName: 'category-template.xlsx',
    headers: ['Name', 'Other Name', 'Raw Material Category'],
    example: ['Cells', '', 'YES'],
  },
  'raw-item': {
    fileName: 'raw-item-template.xlsx',
    headers: [
      'Name',
      'Part Type',
      'Model',
      'Brand',
      'Category',
      'Placement',
      'Cost',
      'Reorder',
      'Cell Capacity (mAh)',
      'Cell Voltage (V)',
      'Cell Size',
      'Cell Brand',
    ],
    example: [
      'Samsung INR18650-25R',
      'Cell',
      'INR18650-25R',
      'Samsung',
      'Cells',
      'Internal',
      '250',
      '10',
      '2500',
      '3.7',
      '18650',
      'Samsung',
    ],
  },
  product: {
    fileName: 'product-template.xlsx',
    headers: [
      'Name',
      'Other Name',
      'Type',
      'Placement',
      'Brand',
      'Category',
      'Cost',
      'Suggested Cell',
      'Cell Count',
      'Unit',
      'Barcode',
    ],
    example: ['Dell 5547', '', 'New', 'Internal', 'Dell', 'Laptop Battery', '8500', 'Samsung INR18650-25R', '6', 'pc', ''],
  },
  customer: {
    fileName: 'customer-template.xlsx',
    headers: ['Name', 'Code', 'Phone', 'Mobile', 'CNIC', 'Address', 'City', 'Province', 'Email'],
    example: ['Ali Traders', 'C-001', '0300-1234567', '', '35202-1234567-1', 'Main Bazaar', 'Multan', 'Punjab', 'ali@example.com'],
  },
  supplier: {
    fileName: 'supplier-template.xlsx',
    headers: ['Name', 'Company', 'Contact Person', 'Phone', 'Email', 'Address', 'City', 'CNIC', 'NTN', 'STRN'],
    example: ['Zenith Metals', 'Zenith Metals (Pvt) Ltd', 'Mr. Khan', '042-1234567', 'z@example.com', 'Industrial Area', 'Lahore', '', '1234567-8', ''],
  },
  employee: {
    fileName: 'employee-template.xlsx',
    headers: ['First Name', 'Last Name', 'Code', 'Phone', 'Mobile', 'CNIC', 'Gender', 'City', 'Province', 'Basic Salary', 'Join Date', 'Branch'],
    example: ['Ahmed', 'Khan', 'EMP-01', '0300-1111111', '', '35202-2222222-2', 'M', 'Multan', 'Punjab', '40000', '2026-01-01', 'Multan'],
  },
};

/** Build the .xlsx for one template: a bold header row plus one example row. */
export async function buildTemplate(tpl: Template): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');

  ws.addRow(tpl.headers);
  ws.addRow(tpl.example);

  const header = ws.getRow(1);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBECFF' } };
  });

  ws.columns.forEach((col, i) => {
    const header = tpl.headers[i] ?? '';
    col.width = Math.max(16, header.length + 4);
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
}
