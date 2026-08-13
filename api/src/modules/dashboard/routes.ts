/**
 * Dashboard data (Phase 12). One endpoint returns every figure and chart series
 * the dashboard needs, branch-scoped: a branch sees only itself, the super admin
 * sees everything plus per-branch series.
 */
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { db } from '../../core/db/index.js';

const now = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${new Date().toISOString().slice(0, 7)}-01`;

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.authenticate,
    handler: async (req) => {
      const { branchId: requested } = z.object({ branchId: z.coerce.number().int().optional() }).parse(req.query);
      const branchId = req.principal.isSuperAdmin ? (requested ?? null) : req.principal.branchId;
      const bScope = branchId === null ? sql`` : sql`AND branch_id = ${branchId}`;
      const bWhere = branchId === null ? sql`` : sql`WHERE branch_id = ${branchId}`;

      // Hero: this month's sales vs last month.
      const salesMonth = await sql<{ current: string; previous: string }>`
        SELECT COALESCE(SUM(net_total) FILTER (WHERE date >= ${monthStart()}), 0)::text AS current,
               COALESCE(SUM(net_total) FILTER (WHERE date >= date_trunc('month', now()) - interval '1 month'
                                                   AND date < ${monthStart()}), 0)::text AS previous
        FROM sale WHERE 1=1 ${bScope}
      `.execute(db);

      const salesToday = await sql<{ v: string }>`
        SELECT COALESCE(SUM(net_total), 0)::text AS v FROM sale WHERE date = ${now()} ${bScope}
      `.execute(db);

      // 12-month sales trend.
      const salesByMonth = await sql<{ month: string; total: string }>`
        SELECT to_char(d.m, 'YYYY-MM') AS month, COALESCE(SUM(s.net_total), 0)::text AS total
        FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') d(m)
        LEFT JOIN sale s ON to_char(s.date, 'YYYY-MM') = to_char(d.m, 'YYYY-MM') ${branchId === null ? sql`` : sql`AND s.branch_id = ${branchId}`}
        GROUP BY d.m ORDER BY d.m
      `.execute(db);

      // Sales by branch (super admin only).
      const salesByBranch = branchId === null
        ? await sql<{ name: string; total: string }>`
            SELECT b.name, COALESCE(SUM(s.net_total), 0)::text AS total
            FROM branch b LEFT JOIN sale s ON s.branch_id = b.id
            WHERE b.id > 0 AND b.type <> 'WAREHOUSE'
            GROUP BY b.name ORDER BY total DESC
          `.execute(db)
        : { rows: [] as Array<{ name: string; total: string }> };

      // Best sellers.
      const bestSellers = await sql<{ name: string; qty: string }>`
        SELECT COALESCE(p.name, '—') AS name, COALESCE(SUM(d.qty), 0)::text AS qty
        FROM sale_detail d
        JOIN sale s ON s.id = d.sale_id
        LEFT JOIN product p ON p.id = d.pid
        WHERE d.line_type = 'PRODUCT' ${branchId === null ? sql`` : sql`AND s.branch_id = ${branchId}`}
        GROUP BY p.name ORDER BY qty DESC LIMIT 10
      `.execute(db);

      const [stock, lowStock, deadStock, dues, receivables, production, warranty, labRevenue, estore] = await Promise.all([
        sql<{ v: string }>`
          SELECT COALESCE(SUM(qty * price), 0)::text AS v
          FROM stock_movement WHERE kind = 'FINISH' ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`}
        `.execute(db),
        // Low stock is a per-branch concept — the threshold lives on
        // branch_product, so the count joins that against actual on-hand.
        sql<{ n: string }>`
          WITH onhand AS (
            SELECT branch_id, pid, SUM(qty) AS qty
            FROM stock_movement WHERE kind = 'FINISH'
            GROUP BY branch_id, pid
          )
          SELECT count(*)::text AS n
          FROM branch_product bp
          JOIN product p ON p.id = bp.product_id
          LEFT JOIN onhand o ON o.pid = bp.product_id AND o.branch_id = bp.branch_id
          WHERE p.is_active AND bp.is_active
            AND COALESCE(o.qty, 0) <= bp.low_stock_threshold
            ${branchId === null ? sql`` : sql`AND bp.branch_id = ${branchId}`}
        `.execute(db),
        sql<{ n: string }>`
          WITH moves AS (SELECT pid, MAX(date) AS last FROM stock_movement WHERE kind = 'FINISH' ${branchId === null ? sql`` : sql`AND branch_id = ${branchId}`} GROUP BY pid)
          SELECT count(*)::text AS n FROM product p LEFT JOIN moves m ON m.pid = p.id
          WHERE p.is_active AND (m.last IS NULL OR m.last <= now() - interval '90 days')
        `.execute(db),
        sql<{ v: string }>`
          SELECT COALESCE(SUM(dr) - SUM(cr), 0)::text AS v
          FROM transactions WHERE account_id = 1010502
        `.execute(db),
        sql<{ v: string }>`
          SELECT COALESCE(SUM(t.dr) - SUM(t.cr), 0)::text AS v
          FROM transactions t JOIN customer c ON c.account_id = t.account_id
          WHERE c.account_id IS NOT NULL AND c.account_id <> 1010201 ${branchId === null ? sql`` : sql`AND c.branch_id = ${branchId}`}
        `.execute(db),
        sql<{ v: string }>`SELECT COALESCE(SUM(qty), 0)::text AS v FROM production_output ${bWhere}`.execute(db),
        sql<{ v: string }>`SELECT COALESCE(SUM(qty), 0)::text AS v FROM warranty_claim_detail WHERE outcome IS NOT NULL ${branchId === null ? sql`` : sql`AND claim_id IN (SELECT id FROM warranty_claim WHERE branch_id = ${branchId})`}`.execute(db),
        sql<{ v: string }>`SELECT COALESCE(SUM(gross), 0)::text AS v FROM lab WHERE 1=1 ${bScope}`.execute(db),
        sql<{ n: string }>`SELECT count(*)::text AS n FROM estore_shipment ${bWhere}`.execute(db),
      ]);

      // Branch selector for the super admin — name + id for the dropdown.
      const branches = req.principal.isSuperAdmin
        ? await db
            .selectFrom('branch')
            .select(['id', 'name'])
            .where('id', '>', 0)
            .orderBy('name')
            .execute()
        : [];

      return {
        hero: {
          month: salesMonth.rows[0]?.current ?? '0.00',
          previous: salesMonth.rows[0]?.previous ?? '0.00',
        },
        figures: {
          salesToday: salesToday.rows[0]?.v ?? '0.00',
          stockValue: stock.rows[0]?.v ?? '0.00',
          lowStock: lowStock.rows[0]?.n ?? '0',
          deadStock: deadStock.rows[0]?.n ?? '0',
          dues: dues.rows[0]?.v ?? '0.00',
          receivables: receivables.rows[0]?.v ?? '0.00',
          productionPieces: production.rows[0]?.v ?? '0.00',
          warrantyUnits: warranty.rows[0]?.v ?? '0.00',
          labRevenue: labRevenue.rows[0]?.v ?? '0.00',
          estoreShipments: estore.rows[0]?.n ?? '0',
        },
        charts: {
          salesByMonth: salesByMonth.rows,
          salesByBranch: salesByBranch.rows,
          bestSellers: bestSellers.rows,
        },
        branches,
      };
    },
  });
}
