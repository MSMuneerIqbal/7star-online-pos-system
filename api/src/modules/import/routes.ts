/**
 * Import routes — Excel upload for raw items (Phase 3, first consumer of the
 * preview-before-commit machinery in `service.ts`).
 *
 * Two endpoints: `preview` parses the upload and returns every row classified
 * NEW / UPDATE / ERROR without writing anything; `commit` applies the rows the
 * operator accepted. Raw items are master catalog, so both are super-admin-only.
 */
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { badRequest, forbidden, notFound } from '../../core/errors.js';
import { ACTION, actionCode } from '../../core/crud.js';
import { commitRawImport, previewRawImport, type RawImportRow } from './service.js';
import { buildTemplate, TEMPLATES } from './templates.js';

/** View permission for each template's owning screen (form id, form code). */
const TEMPLATE_PERMS: Record<string, { formId: number; formCode: number }> = {
  brand: { formId: 3, formCode: 202 },
  category: { formId: 4, formCode: 203 },
  'raw-item': { formId: 5, formCode: 204 },
  product: { formId: 6, formCode: 205 },
  customer: { formId: 7, formCode: 206 },
  supplier: { formId: 8, formCode: 207 },
  employee: { formId: 9, formCode: 208 },
};

const importRowSchema = z.object({
  name: z.string(),
  partType: z.enum(['CELL', 'COMPLETE_SET', 'OTHER']),
  model: z.string().nullish(),
  brand: z.string().nullish(),
  category: z.string().nullish(),
  placement: z.enum(['INT', 'EXT']).nullish(),
  cost: z.string(),
  reorder: z.string(),
  cellCapacityMah: z.number().int().positive().nullish(),
  cellVoltage: z.string().nullish(),
  cellSize: z.string().nullish(),
  cellBrand: z.string().nullish(),
});

const commitBody = z.object({ rows: z.array(importRowSchema).min(1, 'No rows to import') });

export default async function importRoutes(app: FastifyInstance): Promise<void> {
  // Multipart is scoped to this router — nothing else in the API takes uploads.
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });

  app.post('/raw-products/preview', {
    preHandler: app.requireAction(5, 2041),
    handler: async (req) => {
      if (!req.principal.isSuperAdmin) {
        throw forbidden('Only the super admin can import raw items');
      }

      const file = await req.file();
      if (!file) throw badRequest('Upload a spreadsheet file');

      const buffer = await file.toBuffer();
      return previewRawImport(buffer);
    },
  });

  app.post('/raw-products/commit', {
    preHandler: app.requireAction(5, 2041),
    handler: async (req) => {
      if (!req.principal.isSuperAdmin) {
        throw forbidden('Only the super admin can import raw items');
      }

      const { rows } = commitBody.parse(req.body);
      return commitRawImport(req.principal, rows as RawImportRow[]);
    },
  });

  /** A blank sample spreadsheet, so the operator knows the expected columns. */
  app.get('/template/:kind', {
    preHandler: async (req, reply) => {
      const { kind } = req.params as { kind: string };
      const perm = TEMPLATE_PERMS[kind];
      if (!perm) throw notFound('Template');
      await app.requireAction(perm.formId, actionCode(perm.formCode, ACTION.VIEW))(req, reply);
    },
    handler: async (req, reply) => {
      const { kind } = req.params as { kind: string };
      const tpl = TEMPLATES[kind];
      if (!tpl) throw notFound('Template');

      const buffer = await buildTemplate(tpl);
      reply.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      reply.header('Content-Disposition', `attachment; filename="${tpl.fileName}"`);
      return reply.send(buffer);
    },
  });
}
