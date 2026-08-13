import { useEffect, useRef, useState } from 'react';
import { Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';
import { Modal } from '@/components/ui/Modal';

interface ImportDataRow {
  name: string;
  partType: string;
  model: string | null;
  brand: string | null;
  category: string | null;
  placement: string | null;
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
  data: ImportDataRow | null;
  errors: string[];
}

interface ImportModalProps {
  open: boolean;
  title: string;
  previewPath: string;
  commitPath: string;
  onClose: () => void;
  onImported: () => void;
}

const STATUS_STYLE: Record<PreviewRow['status'], string> = {
  NEW: 'bg-emerald-100 text-emerald-800',
  UPDATE: 'bg-amber-100 text-amber-800',
  ERROR: 'bg-red-100 text-red-700',
};

const STATUS_LABEL: Record<PreviewRow['status'], string> = {
  NEW: 'New',
  UPDATE: 'Update',
  ERROR: 'Error',
};

/**
 * Excel import — upload, preview before commit, then apply the accepted rows.
 *
 * Colour-coding follows the old apps: green rows are NEW, amber UPDATE, red
 * ERROR. Error rows are never committed; the operator can also uncheck any
 * NEW/UPDATE row before committing. Reusable for products, customers and
 * opening stock later — only the endpoint paths differ.
 */
export function ImportModal({ open, title, previewPath, commitPath, onClose, onImported }: ImportModalProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setFile(null);
      setRows([]);
      setSelected(new Set());
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }, [open]);

  const preview = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api.upload<{ rows: PreviewRow[] }>(previewPath, form);
      setRows(res.rows);
      setSelected(new Set(res.rows.filter((r) => r.status !== 'ERROR').map((r) => r.rowNumber)));
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not read the spreadsheet');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (rowNumber: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  };

  const commit = async () => {
    const chosen = rows.filter((r) => selected.has(r.rowNumber) && r.data).map((r) => r.data);
    if (chosen.length === 0) return;
    setBusy(true);
    try {
      const res = await api.post<{
        created: number;
        updated: number;
        skipped: Array<{ name: string; errors: string[] }>;
      }>(commitPath, { rows: chosen });

      toast.success(`Imported ${res.created} new, ${res.updated} updated`);
      if (res.skipped.length > 0) {
        toast.error(`${res.skipped.length} row(s) skipped — see the preview`);
      }
      onImported();
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not import');
    } finally {
      setBusy(false);
    }
  };

  const checkable = rows.filter((r) => r.status !== 'ERROR').length;

  return (
    <Modal
      open={open}
      title={title}
      size="lg"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={rows.length === 0 || selected.size === 0 || busy}
            onClick={() => void commit()}
          >
            {busy ? 'Working…' : `Import ${selected.size} row(s)`}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label htmlFor="import-file" className="field-label">
              Spreadsheet (.xlsx)
            </label>
            <input
              ref={fileInput}
              id="import-file"
              type="file"
              accept=".xlsx,.xls"
              className="field-input"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <button type="button" className="btn-primary" disabled={!file || busy} onClick={() => void preview()}>
            <Upload className="size-3.5" />
            Preview
          </button>
        </div>

        {rows.length > 0 && (
          <div className="max-h-96 overflow-auto rounded-md border border-slate-200">
            <table className="w-full border-collapse text-sm">
              <thead className="sticky top-0 bg-slate-50">
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="w-8 px-2 py-1.5">✓</th>
                  <th className="w-12 px-2 py-1.5">Row</th>
                  <th className="px-2 py-1.5">Status</th>
                  <th className="px-2 py-1.5">Name</th>
                  <th className="px-2 py-1.5">Type</th>
                  <th className="px-2 py-1.5 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={r.rowNumber}
                    className={cn(
                      'border-t border-slate-100 align-top',
                      r.status === 'ERROR' && 'bg-red-50/50',
                    )}
                  >
                    <td className="px-2 py-1.5">
                      {r.status !== 'ERROR' && (
                        <input
                          type="checkbox"
                          aria-label={`Include row ${r.rowNumber}`}
                          checked={selected.has(r.rowNumber)}
                          onChange={() => toggle(r.rowNumber)}
                          className="rounded-sm border-slate-300"
                        />
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-slate-400 tabular">{r.rowNumber}</td>
                    <td className="px-2 py-1.5">
                      <span
                        className={cn(
                          'inline-block rounded-sm px-1.5 py-0.5 text-xs font-medium',
                          STATUS_STYLE[r.status],
                        )}
                      >
                        {STATUS_LABEL[r.status]}
                      </span>
                    </td>
                    <td className="px-2 py-1.5">
                      <div className="font-medium">{r.data?.name ?? '—'}</div>
                      {r.errors.length > 0 && (
                        <div className="text-xs text-red-700">{r.errors.join('; ')}</div>
                      )}
                    </td>
                    <td className="px-2 py-1.5">{r.data?.partType ?? '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular">
                      {r.data ? fmtMoney(r.data.cost) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length > 0 && (
          <p className="text-xs text-slate-500">
            {rows.length} row(s) read — {checkable} will be imported, {rows.length - checkable} in error.
            Uncheck a row to leave it out.
          </p>
        )}
      </div>
    </Modal>
  );
}
