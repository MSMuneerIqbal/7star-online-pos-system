/**
 * Report routes.
 *
 * Legacy form/action codes, all of which pointed at controllers that never
 * existed:
 *   31/6011 Stock Raw      32/6021 Item Ledger Raw
 *   33/6031 Stock Finish   34/6041 Item Ledger Finish
 *   35/6051 Sale Report    36/6061 Purchase Report
 *   27/7051 Cash Book      29/7071 Income Statement   30/7081 Balance Sheet
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formPermissions } from '../../core/crud.js';
import { buildReportWorkbook } from './excel.js';
import * as service from './service.js';

const STOCK_RAW = formPermissions(31, 601);
const LEDGER_RAW = formPermissions(32, 602);
const STOCK_FINISH = formPermissions(33, 603);
const LEDGER_FINISH = formPermissions(34, 604);
const SALE_REPORT = formPermissions(35, 605);
const PURCHASE_REPORT = formPermissions(36, 606);
const CASH_BOOK = formPermissions(27, 705);
const INCOME_STATEMENT = formPermissions(29, 707);
const BALANCE_SHEET = formPermissions(30, 708);

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');

const rangeQuery = z.object({
  from: dateString,
  to: dateString,
  branchId: z.coerce.number().int().optional(),
});

const asAtQuery = z.object({
  asAt: dateString,
  branchId: z.coerce.number().int().optional(),
});

export default async function reportRoutes(app: FastifyInstance): Promise<void> {
  // ---- stock ------------------------------------------------------------
  app.get('/stock/raw', {
    preHandler: app.requireAction(STOCK_RAW.formId, STOCK_RAW.view),
    handler: async (req) => {
      const q = asAtQuery.parse(req.query);
      return service.getStockReport(req.principal, { kind: 'RAW', ...q });
    },
  });

  app.get('/stock/finish', {
    preHandler: app.requireAction(STOCK_FINISH.formId, STOCK_FINISH.view),
    handler: async (req) => {
      const q = asAtQuery.parse(req.query);
      return service.getStockReport(req.principal, { kind: 'FINISH', ...q });
    },
  });

  // ---- item ledger ------------------------------------------------------
  app.get('/item-ledger/raw', {
    preHandler: app.requireAction(LEDGER_RAW.formId, LEDGER_RAW.view),
    handler: async (req) => {
      const q = rangeQuery.extend({ pid: z.coerce.number().int().positive() }).parse(req.query);
      return service.getItemLedger(req.principal, { kind: 'RAW', ...q });
    },
  });

  app.get('/item-ledger/finish', {
    preHandler: app.requireAction(LEDGER_FINISH.formId, LEDGER_FINISH.view),
    handler: async (req) => {
      const q = rangeQuery.extend({ pid: z.coerce.number().int().positive() }).parse(req.query);
      return service.getItemLedger(req.principal, { kind: 'FINISH', ...q });
    },
  });

  /** Item pickers for the two ledgers. */
  app.get('/items/:kind', {
    preHandler: app.requireAction(LEDGER_RAW.formId, LEDGER_RAW.view),
    handler: async (req) => {
      const { kind } = z.object({ kind: z.enum(['raw', 'finish']) }).parse(req.params);
      const { db } = await import('../../core/db/index.js');

      return kind === 'raw'
        ? db
            .selectFrom('raw_product')
            .select(['id', 'name'])
            .where('is_active', '=', true)
            .orderBy('name')
            .execute()
        : db
            .selectFrom('product')
            .select(['id', 'name'])
            .where('is_active', '=', true)
            .orderBy('name')
            .execute();
    },
  });

  // ---- sale / purchase --------------------------------------------------
  app.get('/sales', {
    preHandler: app.requireAction(SALE_REPORT.formId, SALE_REPORT.view),
    handler: async (req) => service.getSaleReport(req.principal, rangeQuery.parse(req.query)),
  });

  app.get('/purchases', {
    preHandler: app.requireAction(PURCHASE_REPORT.formId, PURCHASE_REPORT.view),
    handler: async (req) => service.getPurchaseReport(req.principal, rangeQuery.parse(req.query)),
  });

  // ---- financial --------------------------------------------------------
  app.get('/cash-book', {
    preHandler: app.requireAction(CASH_BOOK.formId, CASH_BOOK.view),
    handler: async (req) => {
      const q = rangeQuery.extend({ account: z.coerce.number().int().optional() }).parse(req.query);
      return service.getCashBook(req.principal, q);
    },
  });

  app.get('/income-statement', {
    preHandler: app.requireAction(INCOME_STATEMENT.formId, INCOME_STATEMENT.view),
    handler: async (req) => service.getIncomeStatementWithMargin(req.principal, rangeQuery.parse(req.query)),
  });

  app.get('/balance-sheet', {
    preHandler: app.requireAction(BALANCE_SHEET.formId, BALANCE_SHEET.view),
    handler: async (req) => service.getBalanceSheet(req.principal, asAtQuery.parse(req.query)),
  });

  // ---- new reports -------------------------------------------------------
  app.get('/low-stock', {
    preHandler: app.requireAction(STOCK_FINISH.formId, STOCK_FINISH.view),
    handler: async (req) => {
      const q = z.object({ branchId: z.coerce.number().int().optional() }).parse(req.query);
      return service.getLowStock(req.principal, q);
    },
  });

  app.get('/dead-stock', {
    preHandler: app.requireAction(STOCK_FINISH.formId, STOCK_FINISH.view),
    handler: async (req) => {
      const q = z.object({ branchId: z.coerce.number().int().optional(), days: z.coerce.number().int().optional() }).parse(req.query);
      return service.getDeadStock(req.principal, q);
    },
  });

  app.get('/aged-receivables', {
    preHandler: app.requireAction(SALE_REPORT.formId, SALE_REPORT.view),
    handler: async (req) => {
      const q = z.object({ branchId: z.coerce.number().int().optional() }).parse(req.query);
      return service.getAgedReceivables(req.principal, q);
    },
  });

  // ---- excel exports -----------------------------------------------------
  app.get('/stock/finish/export', {
    preHandler: app.requireAction(STOCK_FINISH.formId, STOCK_FINISH.view),
    handler: async (req, reply) => {
      const q = asAtQuery.parse(req.query);
      const r = await service.getStockReport(req.principal, { kind: 'FINISH', ...q });
      const buf = await buildReportWorkbook({
        title: `Stock Report — Finish (as at ${r.asAt})`,
        summary: [{ label: 'Total value at cost', value: r.totalValue }],
        columns: [
          { header: 'Item', key: 'name' },
          { header: 'Opening', key: 'opening' },
          { header: 'In', key: 'inQty' },
          { header: 'Out', key: 'outQty' },
          { header: 'Closing', key: 'closing' },
          { header: 'Reorder', key: 'reorderLevel' },
          { header: 'Value', key: 'value' },
        ],
        rows: r.rows,
      });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', 'attachment; filename="stock-report.xlsx"');
      return reply.send(buf);
    },
  });

  app.get('/sales/export', {
    preHandler: app.requireAction(SALE_REPORT.formId, SALE_REPORT.view),
    handler: async (req, reply) => {
      const r = await service.getSaleReport(req.principal, rangeQuery.parse(req.query));
      const buf = await buildReportWorkbook({
        title: `Sale Report (${r.from} to ${r.to})`,
        summary: [
          { label: 'Gross', value: r.totals.gross },
          { label: 'Net', value: r.totals.net },
          { label: 'Received', value: r.totals.received },
          { label: 'Remaining', value: r.totals.remaining },
        ],
        columns: [
          { header: 'Invoice', key: 'id' },
          { header: 'Date', key: 'date' },
          { header: 'Customer', key: 'party' },
          { header: 'Gross', key: 'gross_total' },
          { header: 'Discount', key: 'discount' },
          { header: 'Net', key: 'net_total' },
          { header: 'Received', key: 'received' },
          { header: 'Remaining', key: 'remaining' },
        ],
        rows: r.rows,
      });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', 'attachment; filename="sale-report.xlsx"');
      return reply.send(buf);
    },
  });

  app.get('/purchases/export', {
    preHandler: app.requireAction(PURCHASE_REPORT.formId, PURCHASE_REPORT.view),
    handler: async (req, reply) => {
      const r = await service.getPurchaseReport(req.principal, rangeQuery.parse(req.query));
      const buf = await buildReportWorkbook({
        title: `Purchase Report (${r.from} to ${r.to})`,
        summary: [
          { label: 'Sub total', value: r.totals.sub },
          { label: 'Freight', value: r.totals.freight },
          { label: 'Net', value: r.totals.net },
        ],
        columns: [
          { header: 'Invoice', key: 'id' },
          { header: 'Date', key: 'date' },
          { header: 'Supplier', key: 'party' },
          { header: 'Sub total', key: 'sub_total' },
          { header: 'Freight', key: 'rent' },
          { header: 'Net', key: 'net_total' },
          { header: 'Paid', key: 'paid' },
        ],
        rows: r.rows,
      });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', 'attachment; filename="purchase-report.xlsx"');
      return reply.send(buf);
    },
  });

  app.get('/income-statement/export', {
    preHandler: app.requireAction(INCOME_STATEMENT.formId, INCOME_STATEMENT.view),
    handler: async (req, reply) => {
      const r = await service.getIncomeStatementWithMargin(req.principal, rangeQuery.parse(req.query));
      const buf = await buildReportWorkbook({
        title: `Income Statement (${r.from} to ${r.to})`,
        summary: [
          { label: 'Revenue', value: r.totalRevenue },
          { label: 'Cost of goods sold', value: r.totalCogs },
          { label: 'Gross margin', value: r.grossMargin },
          { label: 'Operating expenses', value: r.totalOperating },
          { label: 'Net profit', value: r.netProfit },
        ],
        columns: [
          { header: 'Account', key: 'name' },
          { header: 'Amount', key: 'amount' },
        ],
        rows: [
          ...r.revenue.map((l) => ({ name: l.name, amount: l.amount })),
          { name: '— Cost of goods sold —', amount: r.totalCogs },
          ...r.cogs.map((l) => ({ name: l.name, amount: l.amount })),
          { name: '— Operating expenses —', amount: r.totalOperating },
          ...r.operating.map((l) => ({ name: l.name, amount: l.amount })),
        ],
      });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', 'attachment; filename="income-statement.xlsx"');
      return reply.send(buf);
    },
  });

  app.get('/balance-sheet/export', {
    preHandler: app.requireAction(BALANCE_SHEET.formId, BALANCE_SHEET.view),
    handler: async (req, reply) => {
      const r = await service.getBalanceSheet(req.principal, asAtQuery.parse(req.query));
      const buf = await buildReportWorkbook({
        title: `Balance Sheet (as at ${r.asAt})`,
        summary: [
          { label: 'Total assets', value: r.totalAssets },
          { label: 'Total liabilities', value: r.totalLiabilities },
          { label: 'Total equity', value: r.totalEquity },
          { label: 'Retained profit', value: r.retainedProfit },
        ],
        columns: [
          { header: 'Account', key: 'name' },
          { header: 'Amount', key: 'amount' },
        ],
        rows: [
          { name: '— Assets —', amount: '' },
          ...r.assets.map((l) => ({ name: l.name, amount: l.amount })),
          { name: '— Liabilities —', amount: '' },
          ...r.liabilities.map((l) => ({ name: l.name, amount: l.amount })),
          { name: '— Equity —', amount: '' },
          ...r.equity.map((l) => ({ name: l.name, amount: l.amount })),
        ],
      });
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', 'attachment; filename="balance-sheet.xlsx"');
      return reply.send(buf);
    },
  });
}
