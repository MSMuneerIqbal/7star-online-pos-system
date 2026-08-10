import { useEffect } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Printer } from 'lucide-react';
import { api } from '@/lib/api';
import { fmtMoney } from '@/lib/money';
import { cn } from '@/lib/cn';

interface PrintLine {
  pname: string;
  qty: string;
  price: string;
  total: string;
  discount: string;
  netTotal: string;
}

interface PrintTotal {
  label: string;
  value: string;
  emphasis?: boolean;
}

interface PrintDoc {
  kind: string;
  title: string;
  number: number;
  date: string;
  company: { name: string; phone: string | null; address: string | null; email: string | null };
  branch: { name: string; address: string | null };
  partyLabel: string;
  party: { name: string; phone: string | null; address: string | null };
  lines: PrintLine[];
  totals: PrintTotal[];
  notes: string | null;
}

/** Which API path serves each printable document type. */
const ENDPOINT: Record<string, string> = {
  sale: 'sales',
  purchase: 'purchases',
  'sale-return': 'sale-returns',
  'purchase-return': 'purchase-returns',
};

/**
 * One print template for every document type.
 *
 * The legacy system had 13 near-identical Print.cshtml files. The API returns a
 * single normalised shape (see api/src/modules/print/service.ts), so adding the
 * remaining document types needs no new component here.
 *
 * `?auto=1` triggers the print dialog on load, which is how the invoice screens
 * link to it.
 */
export function PrintDocumentPage() {
  const { kind = '', id = '' } = useParams();
  const [search] = useSearchParams();

  const endpoint = ENDPOINT[kind];

  const { data, isPending, error } = useQuery({
    queryKey: ['print', kind, id],
    queryFn: () => api.get<PrintDoc>(`/${endpoint}/${id}/print`),
    enabled: Boolean(endpoint && id),
  });

  useEffect(() => {
    if (data && search.get('auto') === '1') {
      // Let the layout settle before opening the dialog, or the first page
      // renders mid-paint in some browsers.
      const t = setTimeout(() => window.print(), 250);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [data, search]);

  if (!endpoint) {
    return <p className="p-6 text-sm text-red-600">Unknown document type “{kind}”.</p>;
  }

  if (isPending) {
    return (
      <div className="grid place-items-center p-12">
        <Loader2 className="size-5 animate-spin text-slate-400" />
      </div>
    );
  }

  if (error || !data) {
    return <p className="p-6 text-sm text-red-600">{(error as Error)?.message ?? 'Not found'}</p>;
  }

  return (
    <div className="mx-auto max-w-3xl bg-white p-6 text-slate-900 print:max-w-none print:p-0">
      <div className="no-print mb-4 flex justify-end">
        <button type="button" className="btn-primary" onClick={() => window.print()}>
          <Printer className="size-3.5" />
          Print
        </button>
      </div>

      {/* Company header */}
      <header className="mb-4 border-b-2 border-slate-800 pb-3">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-xl font-bold tracking-tight">{data.company.name}</h1>
            {data.company.address && (
              <p className="text-xs text-slate-600">{data.company.address}</p>
            )}
            <p className="text-xs text-slate-600">
              {[data.company.phone, data.company.email].filter(Boolean).join('  •  ')}
            </p>
          </div>

          <div className="text-right">
            <h2 className="text-base font-semibold uppercase">{data.title}</h2>
            <p className="text-sm tabular">
              No. <strong>{data.number}</strong>
            </p>
            <p className="text-xs text-slate-600 tabular">{data.date}</p>
          </div>
        </div>
      </header>

      {/* Party + branch */}
      <section className="mb-4 flex justify-between gap-8 text-sm">
        <div>
          <p className="mb-0.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            {data.partyLabel}
          </p>
          <p className="font-medium">{data.party.name || '—'}</p>
          {data.party.phone && <p className="text-xs text-slate-600">{data.party.phone}</p>}
          {data.party.address && <p className="text-xs text-slate-600">{data.party.address}</p>}
        </div>

        <div className="text-right">
          <p className="mb-0.5 text-xs font-semibold tracking-wide text-slate-500 uppercase">
            Branch
          </p>
          <p className="font-medium">{data.branch.name}</p>
          {data.branch.address && <p className="text-xs text-slate-600">{data.branch.address}</p>}
        </div>
      </section>

      {/* Line items */}
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-y border-slate-300 bg-slate-50 text-xs uppercase print:bg-transparent">
            <th scope="col" className="w-8 py-1.5 text-left">
              #
            </th>
            <th scope="col" className="py-1.5 text-left">
              Item
            </th>
            <th scope="col" className="w-20 py-1.5 text-right">
              Qty
            </th>
            <th scope="col" className="w-28 py-1.5 text-right">
              Rate
            </th>
            <th scope="col" className="w-28 py-1.5 text-right">
              Total
            </th>
            <th scope="col" className="w-24 py-1.5 text-right">
              Disc.
            </th>
            <th scope="col" className="w-28 py-1.5 text-right">
              Net
            </th>
          </tr>
        </thead>

        <tbody>
          {data.lines.map((l, i) => (
            <tr key={`${l.pname}-${i}`} className="border-b border-slate-200">
              <td className="py-1 text-slate-500 tabular">{i + 1}</td>
              <td className="py-1">{l.pname}</td>
              <td className="py-1 text-right tabular">{Number(l.qty)}</td>
              <td className="py-1 text-right tabular">{fmtMoney(l.price)}</td>
              <td className="py-1 text-right tabular">{fmtMoney(l.total)}</td>
              <td className="py-1 text-right tabular">{fmtMoney(l.discount)}</td>
              <td className="py-1 text-right font-medium tabular">{fmtMoney(l.netTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <section className="mt-3 flex justify-end">
        <dl className="w-64 text-sm">
          {data.totals.map((t) => (
            <div
              key={t.label}
              className={cn(
                'flex justify-between py-0.5',
                t.emphasis && 'border-t border-slate-300 pt-1 font-semibold',
              )}
            >
              <dt>{t.label}</dt>
              <dd className="tabular">{fmtMoney(t.value)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {data.notes && (
        <section className="mt-4 border-t border-slate-200 pt-2 text-xs text-slate-600">
          <strong>Notes:</strong> {data.notes}
        </section>
      )}

      <footer className="mt-10 flex justify-between gap-8 text-xs text-slate-600">
        <div className="w-48 border-t border-slate-400 pt-1 text-center">Prepared by</div>
        <div className="w-48 border-t border-slate-400 pt-1 text-center">Received by</div>
      </footer>
    </div>
  );
}
