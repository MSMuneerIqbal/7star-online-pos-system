/**
 * Shared helpers for list endpoints.
 *
 * Deliberately NOT a generic route factory. An earlier attempt at one needed a
 * dozen `as never` casts to satisfy Kysely and still got branch scoping wrong
 * for `branch` itself, which has no `branch_id` column. Kysely's types are
 * excellent on concrete tables and hostile to erased ones, so modules stay
 * concrete and share only the parts that genuinely repeat: query parsing,
 * paging, and permission-code arithmetic.
 */
import { z } from 'zod';

/** Action sequence within a form's code block. */
export const ACTION = { VIEW: 1, NEW: 2, EDIT: 3, DELETE: 4, PRINT: 5 } as const;

/** action_code = form_code * 10 + sequence. See migration 1700000000003. */
export function actionCode(formCode: number, seq: number): number {
  return formCode * 10 + seq;
}

/** Permission codes for one screen, derived from its legacy form code. */
export function formPermissions(formId: number, formCode: number) {
  return {
    formId,
    view: actionCode(formCode, ACTION.VIEW),
    create: actionCode(formCode, ACTION.NEW),
    edit: actionCode(formCode, ACTION.EDIT),
    remove: actionCode(formCode, ACTION.DELETE),
    print: actionCode(formCode, ACTION.PRINT),
  } as const;
}

export const listQuery = z.object({
  search: z.string().trim().max(200).optional(),
  branchId: z.coerce.number().int().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  dir: z.enum(['asc', 'desc']).default('asc'),
});

export type ListQuery = z.infer<typeof listQuery>;

export interface Paged<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function paged<T>(rows: T[], total: number, q: ListQuery): Paged<T> {
  return { rows, total, page: q.page, pageSize: q.pageSize };
}

export function offset(q: ListQuery): number {
  return (q.page - 1) * q.pageSize;
}

/** Wrap a search term for ILIKE. Returns undefined when there is nothing to match. */
export function likeTerm(search: string | undefined): string | undefined {
  return search ? `%${search}%` : undefined;
}
