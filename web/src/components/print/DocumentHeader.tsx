/**
 * The header every printed document opens with: the masthead, then the document
 * title, number and date on the right, then the issuing branch's own address and
 * phone beneath (DESIGN §2, §8).
 *
 * The masthead itself lives in `components/brand/Masthead` because the login
 * screen carries it too.
 */
import { Masthead } from '@/components/brand/Masthead';

export interface DocumentHeaderBranch {
  name: string;
  address: string | null;
  code: string | null;
  phone: string | null;
}

interface DocumentHeaderProps {
  title: string;
  number: string;
  date: string;
  branch: DocumentHeaderBranch;
}

export function DocumentHeader({ title, number, date, branch }: DocumentHeaderProps) {
  const branchLine = [branch.name, branch.address, branch.phone].filter(Boolean).join('  ·  ');

  return (
    <header className="mb-4 border-b-2 border-slate-800 pb-3">
      <div className="flex items-start justify-between gap-6">
        <Masthead />

        <div className="text-right">
          <h2 className="text-base font-semibold uppercase">{title}</h2>
          <p className="text-sm tabular">
            No. <strong>{number}</strong>
          </p>
          <p className="text-xs text-slate-600 tabular">{date}</p>
        </div>
      </div>

      {branchLine && <p className="mt-2 text-xs text-slate-600">{branchLine}</p>}
    </header>
  );
}
