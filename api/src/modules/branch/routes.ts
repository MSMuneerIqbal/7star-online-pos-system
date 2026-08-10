/**
 * Branch management — the reference module.
 *
 * Legacy form id 2, form code 201. Ports BranchController's Index / Create /
 * Save / Edit / Delete.
 *
 * Branch is the natural first module because it is the thing everything else
 * scopes to, and because it is the one table where "branch scoping" means
 * filtering on `id` rather than `branch_id`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from 'kysely';
import { db, withTransaction } from '../../core/db/index.js';
import { conflict, notFound } from '../../core/errors.js';
import { writeAudit } from '../../core/audit.js';
import { formPermissions, likeTerm, listQuery, offset, paged } from '../../core/crud.js';

const PERM = formPermissions(2, 201);

/** Branch 0 is the "All Branches" sentinel — infrastructure, never editable. */
const SENTINEL_BRANCH = 0;

const branchBody = z.object({
  name: z.string().trim().min(1, 'Name is required').max(150),
  address: z.string().trim().max(500).nullish(),
  longitude: z.coerce.number().min(-180).max(180).default(0),
  latitude: z.coerce.number().min(-90).max(90).default(0),
});

const idParam = z.object({ id: z.coerce.number().int().min(1) });

export default async function branchRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const q = listQuery.parse(req.query);
      const term = likeTerm(q.search);

      let base = db.selectFrom('branch').where('id', '>', SENTINEL_BRANCH);

      // A non-super-admin sees only their own branch.
      if (!req.principal.isSuperAdmin) {
        base = base.where('id', '=', req.principal.branchId);
      }

      if (term) {
        base = base.where((eb) =>
          eb.or([eb('name', 'ilike', term), eb('address', 'ilike', term)]),
        );
      }

      const [rows, count] = await Promise.all([
        base
          .select(['id', 'name', 'address', 'longitude', 'latitude', 'created_at'])
          .orderBy('name', q.dir)
          .limit(q.pageSize)
          .offset(offset(q))
          .execute(),
        base.select(({ fn }) => fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      ]);

      return paged(rows, Number(count.n), q);
    },
  });

  app.get('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.view),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);

      const row = await db
        .selectFrom('branch')
        .selectAll()
        .where('id', '=', id)
        .executeTakeFirst();

      if (!row) throw notFound('Branch');

      // Another branch's record is invisible, not merely forbidden.
      if (!req.principal.isSuperAdmin && id !== req.principal.branchId) {
        throw notFound('Branch');
      }

      return row;
    },
  });

  app.post('/', {
    preHandler: app.requireAction(PERM.formId, PERM.create),
    handler: async (req, reply) => {
      const body = branchBody.parse(req.body);
      await assertNameFree(body.name);

      const created = await withTransaction(async (tx) => {
        const row = await tx
          .insertInto('branch')
          .values({
            name: body.name,
            address: body.address ?? null,
            longitude: String(body.longitude),
            latitude: String(body.latitude),
            created_by: req.principal.empId,
            updated_by: req.principal.empId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'Branch',
            action: 'New',
            detail: `Created Branch: ${row.name} (id ${row.id})`,
            invId: row.id,
          },
          tx,
        );

        return row;
      });

      return reply.status(201).send(created);
    },
  });

  app.put('/:id', {
    preHandler: app.requireAction(PERM.formId, PERM.edit),
    handler: async (req) => {
      const { id } = idParam.parse(req.params);
      const body = branchBody.parse(req.body);

      if (id === SENTINEL_BRANCH) throw conflict('The All Branches sentinel cannot be edited');

      const existing = await db
        .selectFrom('branch')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Branch');
      await assertNameFree(body.name, id);

      return withTransaction(async (tx) => {
        const row = await tx
          .updateTable('branch')
          .set({
            name: body.name,
            address: body.address ?? null,
            longitude: String(body.longitude),
            latitude: String(body.latitude),
            updated_at: new Date(),
            updated_by: req.principal.empId,
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        await writeAudit(
          req.principal,
          {
            form: 'Branch',
            action: 'Edit',
            detail:
              existing.name === row.name
                ? `Updated Branch: ${row.name} (id ${id})`
                : `Renamed Branch ${existing.name} -> ${row.name} (id ${id})`,
            invId: id,
          },
          tx,
        );

        return row;
      });
    },
  });

  app.delete('/:id', {
    // A real DELETE. The legacy app deleted over GET, so any prefetch could
    // destroy a branch.
    preHandler: app.requireAction(PERM.formId, PERM.remove),
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);

      if (id === SENTINEL_BRANCH) throw conflict('The All Branches sentinel cannot be deleted');

      const existing = await db
        .selectFrom('branch')
        .select(['id', 'name'])
        .where('id', '=', id)
        .executeTakeFirst();

      if (!existing) throw notFound('Branch');

      await withTransaction(async (tx) => {
        await assertBranchUnused(id);

        await tx.deleteFrom('branch').where('id', '=', id).execute();

        await writeAudit(
          req.principal,
          {
            form: 'Branch',
            action: 'Delete',
            detail: `Deleted Branch: ${existing.name} (id ${id})`,
            invId: id,
          },
          tx,
        );
      });

      return reply.status(204).send();
    },
  });
}

async function assertNameFree(name: string, exceptId?: number): Promise<void> {
  let q = db.selectFrom('branch').select('id').where('name', 'ilike', name);
  if (exceptId !== undefined) q = q.where('id', '!=', exceptId);

  if (await q.executeTakeFirst()) {
    throw conflict(`A branch named "${name}" already exists`);
  }
}

/**
 * Refuse to delete a branch that other records point at.
 *
 * Postgres would raise a foreign-key error anyway, but it names a constraint
 * rather than the problem. This says which table is holding the reference.
 */
async function assertBranchUnused(id: number): Promise<void> {
  const referencing = await sql<{ table_name: string; n: string }>`
    SELECT 'sale'     AS table_name, count(*)::text AS n FROM sale     WHERE branch_id = ${id}
    UNION ALL SELECT 'purchase', count(*)::text FROM purchase          WHERE branch_id = ${id}
    UNION ALL SELECT 'employee', count(*)::text FROM employee          WHERE branch_id = ${id}
    UNION ALL SELECT 'customer', count(*)::text FROM customer          WHERE branch_id = ${id}
    UNION ALL SELECT 'product',  count(*)::text FROM product           WHERE branch_id = ${id}
    UNION ALL SELECT 'transactions', count(*)::text FROM transactions  WHERE branch_id = ${id}
  `.execute(db);

  const blocking = referencing.rows.filter((r) => Number(r.n) > 0);

  if (blocking.length > 0) {
    throw conflict(
      `This branch still has ${blocking.map((b) => `${b.n} ${b.table_name}`).join(', ')} record(s)`,
      { referencedBy: blocking.map((b) => ({ table: b.table_name, count: Number(b.n) })) },
    );
  }
}
