/**
 * Excel import — preview before commit (SPECS §18).
 *
 * The rule this screen exists to honour: **nothing is written until the operator
 * has seen what will happen.** The upload is parsed and every row comes back
 * classified NEW, UPDATE or ERROR; bad rows are reported with their row number
 * and skipped, never half-imported. That is the behaviour the owner's old apps
 * had, and losing it would be a step backwards from what they already trust.
 *
 * Colour here is doing real work, so it follows DESIGN §4's reserved roles
 * rather than inventing a fourth palette: NEW reads good, UPDATE reads warning,
 * ERROR reads critical — always with the word beside it, never colour alone.
 */
import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlertTriangle, Download, FileUp, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PageHeader } from '@/components/ui/Field';
import { StatusPill } from '@/components/ui/StatusPill';

interface ImportRow {
  name: string;
  partType: 'CELL' | 'COMPLETE_SET' | 'OTHER';
  model: string | null;
  brand: string | null;
  category: string | null;
  placement: 'INT' | 'EXT' | null;
  cost: string;
  reorder: string;
  cellCapacityMah: number | null;
  cellVoltage: string | null;
  cellSize: string | null;
  cellBrand: string | null;
}

interface PreviewRow {
  rowNumber: number;
  status: 'NEW' | 'UPDATE' | 'ERROR';
  data: ImportRow | null;
  errors: string[];
}

interface CommitResult {
  created: number;
  updated: number;
  skipped: Array<{ name: string; errors: string[] }>;
}

/** NEW / UPDATE / ERROR onto the reserved status roles. */
const ROW_ROLE = {
  NEW: 'good',
  UPDATE: 'warning',
  ERROR: 'critical',
} as const;

export function ImportPage() {
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[] | null>(null);
  const [result, setResult] = useState<CommitResult | null>(null);

  const preview = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api.upload<{ rows: PreviewRow[] }>('/import/raw-products/preview', form);
    },
    onSuccess: (data) => {
      setRows(data.rows);
      setResult(null);
    },
    onError: (err) =>
      toast.error(err instanceof ApiError ? err.message : 'Could not read that spreadsheet'),
  });

  const commit = useMutation({
    mutationFn: (importable: ImportRow[]) =>
      api.post<CommitResult>('/import/raw-products/commit', { rows: importable }),
    onSuccess: (data) => {
      setResult(data);
      setRows(null);
      setFileName(null);
      if (fileInput.current) fileInput.current.value = '';
      toast.success(`${data.created} added, ${data.updated} updated`);
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Import failed'),
  });

  const counts = {
    NEW: rows?.filter((r) => r.status === 'NEW').length ?? 0,
    UPDATE: rows?.filter((r) => r.status === 'UPDATE').length ?? 0,
    ERROR: rows?.filter((r) => r.status === 'ERROR').length ?? 0,
  };

  const importable = (rows ?? [])
    .filter((r) => r.status !== 'ERROR' && r.data !== null)
    .map((r) => r.data!);

  function onPick(file: File | undefined) {
    if (!file) return;
    setFileName(file.name);
    preview.mutate(file);
  }

  return (
    <>
      <PageHeader
        title="Import Raw Items"
        subtitle="Nothing is written until you have seen what will change."
        actions={
          <a href="/api/v1/import/template/raw-item" className="btn-secondary" download>
            <Download className="size-3.5" />
            Blank template
          </a>
        }
      />

      <div className="card mb-4 p-4">
        <div className="flex items-center gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={(e) => onPick(e.target.files?.[0])}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={preview.isPending}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp className="size-3.5" />
            {preview.isPending ? 'Reading…' : 'Choose spreadsheet'}
          </button>
          <span className="text-sm text-slate-500">
            {fileName ?? 'No file chosen. Quantities are added to existing stock, never replaced.'}
          </span>
        </div>
      </div>

      {result && (
        <div className="card mb-4 p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Import complete</h2>
          <p className="text-sm text-slate-700">
            <strong className="tabular">{result.created}</strong> added,{' '}
            <strong className="tabular">{result.updated}</strong> updated,{' '}
            <strong className="tabular">{result.skipped.length}</strong> skipped.
          </p>
          {result.skipped.length > 0 && (
            <ul className="mt-2 space-y-1">
              {result.skipped.map((s, i) => (
                <li key={i} className="text-xs text-[var(--color-status-critical)]">
                  {s.name}: {s.errors.join('; ')}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {rows && (
        <>
          <div className="mb-3 flex items-center gap-4">
            <div className="flex gap-2">
              <StatusPill status="NEW" role="good" />
              <span className="text-sm text-slate-600 tabular">{counts.NEW}</span>
              <StatusPill status="UPDATE" role="warning" />
              <span className="text-sm text-slate-600 tabular">{counts.UPDATE}</span>
              <StatusPill status="ERROR" role="critical" />
              <span className="text-sm text-slate-600 tabular">{counts.ERROR}</span>
            </div>

            <div className="ml-auto">
              <button
                type="button"
                className="btn-primary"
                disabled={importable.length === 0 || commit.isPending}
                onClick={() => commit.mutate(importable)}
              >
                <Upload className="size-3.5" />
                Import {importable.length} row{importable.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>

          {counts.ERROR > 0 && (
            <p className="mb-3 flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-[var(--color-status-critical)]">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {counts.ERROR} row{counts.ERROR === 1 ? '' : 's'} will be skipped. Fix them in the
                spreadsheet and upload again — importing now brings in everything else.
              </span>
            </p>
          )}

          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-xs font-medium text-slate-600">
                  <th className="px-2 py-1.5 text-left">Row</th>
                  <th className="px-2 py-1.5 text-left">Status</th>
                  <th className="px-2 py-1.5 text-left">Name</th>
                  <th className="px-2 py-1.5 text-left">Part type</th>
                  <th className="px-2 py-1.5 text-right">Cost</th>
                  <th className="px-2 py-1.5 text-left">Problem</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.rowNumber}
                    className={cn(
                      'border-b border-slate-100 last:border-0',
                      // Row state is a left edge, never a filled row — a fill
                      // destroys the readability of the numbers on it (DESIGN §4).
                      r.status === 'ERROR' && 'border-l-2 border-l-[var(--color-status-critical)]',
                      r.status === 'NEW' && 'border-l-2 border-l-[var(--color-status-good)]',
                      r.status === 'UPDATE' && 'border-l-2 border-l-[var(--color-status-warning)]',
                    )}
                  >
                    <td className="px-2 py-1 text-xs text-slate-400 tabular">{r.rowNumber}</td>
                    <td className="px-2 py-1">
                      <StatusPill status={r.status} role={ROW_ROLE[r.status]} />
                    </td>
                    <td className="px-2 py-1 text-slate-800">{r.data?.name ?? '—'}</td>
                    <td className="px-2 py-1 text-slate-600">{r.data?.partType ?? '—'}</td>
                    <td className="px-2 py-1 text-right text-slate-800 tabular">
                      {r.data?.cost ?? '—'}
                    </td>
                    <td className="px-2 py-1 text-xs text-[var(--color-status-critical)]">
                      {r.errors.join('; ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {!rows && !result && (
        <p className="text-sm text-slate-500">
          Choose a spreadsheet to see what would be added or changed before anything is written.
        </p>
      )}
    </>
  );
}
