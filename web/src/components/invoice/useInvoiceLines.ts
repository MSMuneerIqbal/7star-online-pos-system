import { useCallback, useMemo, useState } from 'react';
import { addMoney, fmtMoney, mulMoney, subMoney } from '@/lib/money';

export interface InvoiceLine {
  /** Stable client-side key — rows get reordered and removed. */
  key: string;
  pid: number | null;
  pname: string;
  qty: string;
  price: string;
  discount: string;
}

export interface PricedLine extends InvoiceLine {
  total: string;
  netTotal: string;
}

export interface InvoiceTotals {
  lines: PricedLine[];
  grossTotal: string;
  lineDiscount: string;
  totalDiscount: string;
  netTotal: string;
  remaining: string;
}

let counter = 0;
const nextKey = () => `line-${++counter}`;

export function emptyLine(): InvoiceLine {
  return { key: nextKey(), pid: null, pname: '', qty: '1', price: '0', discount: '0' };
}

export function toLine(input: Omit<InvoiceLine, 'key'>): InvoiceLine {
  return { ...input, key: nextKey() };
}

/**
 * Invoice line-item state and running totals.
 *
 * The server recomputes all of this from the product table before posting (see
 * api/src/modules/sale/service.ts), so these figures exist purely so the
 * operator watches the invoice update as they type. They are never the
 * authority on money.
 */
export function useInvoiceLines(initial?: InvoiceLine[]) {
  const [lines, setLines] = useState<InvoiceLine[]>(initial ?? [emptyLine()]);
  const [invoiceDiscount, setInvoiceDiscount] = useState('0');
  const [service, setService] = useState('0');
  const [received, setReceived] = useState('0');

  const addLine = useCallback(() => setLines((ls) => [...ls, emptyLine()]), []);

  const removeLine = useCallback(
    (key: string) =>
      // Never leave the grid empty — an invoice always has at least one row.
      setLines((ls) => (ls.length === 1 ? [emptyLine()] : ls.filter((l) => l.key !== key))),
    [],
  );

  const updateLine = useCallback(
    (key: string, patch: Partial<Omit<InvoiceLine, 'key'>>) =>
      setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))),
    [],
  );

  const reset = useCallback((next?: InvoiceLine[]) => {
    setLines(next ?? [emptyLine()]);
    setInvoiceDiscount('0');
    setService('0');
    setReceived('0');
  }, []);

  const totals = useMemo<InvoiceTotals>(() => {
    const priced: PricedLine[] = lines.map((l) => {
      const total = mulMoney(l.qty, l.price);
      return { ...l, total, netTotal: subMoney(total, l.discount) };
    });

    const grossTotal = priced.reduce((acc, l) => addMoney(acc, l.total), '0.00');
    const lineDiscount = priced.reduce((acc, l) => addMoney(acc, l.discount), '0.00');
    const totalDiscount = addMoney(lineDiscount, invoiceDiscount);
    const netTotal = subMoney(addMoney(grossTotal, service), totalDiscount);

    return {
      lines: priced,
      grossTotal,
      lineDiscount,
      totalDiscount,
      netTotal,
      remaining: subMoney(netTotal, received),
    };
  }, [lines, invoiceDiscount, service, received]);

  /** Rows complete enough to submit. */
  const validLines = useMemo(
    () => lines.filter((l) => l.pid !== null && Number(l.qty) > 0),
    [lines],
  );

  /**
   * Client-side mirror of the server's validation. Catching these here avoids a
   * round trip; the server checks them again regardless.
   */
  const errors = useMemo(() => {
    const out: string[] = [];

    if (validLines.length === 0) out.push('Add at least one item');
    if (Number(totals.netTotal) < 0) out.push('Discount is more than the invoice value');

    if (Number(received) > Number(totals.netTotal)) {
      out.push(`Received cannot exceed the invoice total of ${fmtMoney(totals.netTotal)}`);
    }

    for (const [i, l] of totals.lines.entries()) {
      if (l.pid !== null && Number(l.discount) > Number(l.total)) {
        out.push(`Line ${i + 1}: discount is more than the line total`);
      }
    }

    return out;
  }, [validLines, totals, received]);

  return {
    lines,
    totals,
    validLines,
    errors,
    invoiceDiscount,
    service,
    received,
    setInvoiceDiscount,
    setService,
    setReceived,
    addLine,
    removeLine,
    updateLine,
    reset,
  };
}
