/**
 * Customer statement, advances, and history exports (Phase 7 — selling).
 *
 * A credit customer's ledger is their receivable account. The statement lists
 * every invoice, payment, return and advance against that account in date
 * order with a running balance, so it reconciles to the account balance by
 * construction. Credit history and battery history export to Excel.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import ExcelJS from 'exceljs';
import { sql } from 'kysely';
import { db, withTransaction } from '../../core/db/index.js';
import { badRequest, notFound } from '../../core/errors.js';
import { dec, money } from '../../core/money.js';
import { writeAudit } from '../../core/audit.js';
import { assertBranchAccess } from '../../core/rbac.js';
import { formPermissions } from '../../core/crud.js';
import { ACC, VTYPE } from '../../accounting/accounts.js';
import { buildJournal, credit, debit } from '../../accounting/journal.js';
import { postJournal } from '../../accounting/post.js';

// The customer statement shares the Customer form (7) permission.
const CUSTOMER = formPermissions(7, 206);

const idParam = z.object({ id: z.coerce.number().int().positive() });

export default async function customerRoutes(app: FastifyInstance): Promise<void> {
  /** The customer's ledger — every movement against their receivable account. */
  app.get('/:id/statement', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const customer = await db
        .selectFrom('customer')
        .select(['id', 'name', 'account_id', 'branch_id', 'settlement_cycle', 'credit_limit'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!customer) throw notFound('Customer');
      assertBranchAccess(req.principal, customer.branch_id);
      if (!customer.account_id) throw badRequest('This customer has no account');

      const rows = await sql<{ date: string; vtype: string; detail: string; dr: string; cr: string }>`
        SELECT t.date::text AS date, t.vtype, t.detail, t.dr::text AS dr, t.cr::text AS cr
        FROM   transactions t
        WHERE  t.account_id = ${customer.account_id}
        ORDER  BY t.date, t.trans_id, t.id
      `.execute(db);

      let balance = '0.00';
      const entries = rows.rows.map((r) => {
        balance = dec(balance).add(dec(r.dr)).minus(dec(r.cr)).toFixed(2);
        return { date: r.date, vtype: r.vtype, detail: r.detail, debit: r.dr, credit: r.cr, balance };
      });

      return { customer, entries, balance: money(balance) };
    },
  });

  /** Record an advance — a customer pays before the bill. Dr cash / Cr receivable. */
  app.post('/:id/advances', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.edit),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const body = z
        .object({
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          amount: z.union([z.string(), z.number()]).transform(String),
          method: z.enum(['CASH', 'BANK']).default('CASH'),
          note: z.string().max(500).nullish(),
        })
        .parse(req.body);

      const customer = await db
        .selectFrom('customer')
        .select(['id', 'name', 'account_id', 'branch_id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!customer) throw notFound('Customer');
      assertBranchAccess(req.principal, customer.branch_id);
      if (!customer.account_id) throw badRequest('This customer has no account');

      const amount = money(body.amount);
      if (dec(amount).lte(0)) throw badRequest('Advance amount must be greater than zero');

      const row = await withTransaction(async (tx) => {
        const created = await tx
          .insertInto('customer_advance')
          .values({
            customer_id: id,
            branch_id: customer.branch_id,
            date: body.date,
            amount,
            method: body.method,
            note: body.note ?? null,
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();

        const cash = body.method === 'BANK' ? ACC.BANK : ACC.CASH;
        await postJournal(
          tx,
          buildJournal({
            vtype: VTYPE.CASH_RECEIPT,
            date: body.date,
            invId: created.id,
            branchId: customer.branch_id,
            legs: [
              debit(cash, amount, `Advance received – ${customer.name}`),
              credit(customer.account_id, amount, `Advance applied – ${customer.name}`),
            ],
          }),
        );

        await writeAudit(
          req.principal,
          { form: 'Customer', action: 'Edit', detail: `Advance ${amount} for ${customer.name}`, invId: created.id },
          tx,
        );

        return created;
      });

      return reply.status(201).send(row);
    },
  });

  /** Credit history — every ledger entry for the customer, as Excel. */
  app.get('/:id/statement/export', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.view),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const customer = await db
        .selectFrom('customer')
        .select(['id', 'name', 'account_id'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!customer) throw notFound('Customer');
      if (!customer.account_id) throw badRequest('This customer has no account');

      const rows = await sql<{ date: string; vtype: string; detail: string; dr: string; cr: string }>`
        SELECT t.date::text AS date, t.vtype, t.detail, t.dr::text AS dr, t.cr::text AS cr
        FROM   transactions t
        WHERE  t.account_id = ${customer.account_id}
        ORDER  BY t.date, t.trans_id, t.id
      `.execute(db);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Credit History');
      ws.addRow(['Date', 'Type', 'Detail', 'Debit', 'Credit']);
      for (const r of rows.rows) {
        ws.addRow([r.date, r.vtype, r.detail, Number(r.dr), Number(r.cr)]);
      }
      ws.getRow(1).font = { bold: true };

      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${customer.name}-credit-history.xlsx"`);
      return reply.send(buffer);
    },
  });

  /** Battery history — every battery this customer bought, as Excel. */
  app.get('/:id/battery-history/export', {
    preHandler: app.requireAction(CUSTOMER.formId, CUSTOMER.view),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const customer = await db
        .selectFrom('customer')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (!customer) throw notFound('Customer');

      const rows = await sql<{ doc: string; date: string; item: string; qty: string; price: string }>`
        SELECT s.doc_number AS doc, s.date::text AS date, d.pname AS item, d.qty::text AS qty, d.price::text AS price
        FROM   sale_detail d
        JOIN   sale s ON s.id = d.sale_id
        WHERE  s.cust_id = ${id} AND d.line_type = 'PRODUCT'
        ORDER  BY s.date, s.id
      `.execute(db);

      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Battery History');
      ws.addRow(['Invoice', 'Date', 'Item', 'Qty', 'Price']);
      for (const r of rows.rows) {
        ws.addRow([r.doc, r.date, r.item, Number(r.qty), Number(r.price)]);
      }
      ws.getRow(1).font = { bold: true };

      const buffer = Buffer.from(await wb.xlsx.writeBuffer());
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', `attachment; filename="${customer.name}-battery-history.xlsx"`);
      return reply.send(buffer);
    },
  });
}
