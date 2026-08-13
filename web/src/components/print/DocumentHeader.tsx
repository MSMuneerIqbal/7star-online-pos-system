/**
 * The print masthead — every printed document opens with it.
 *
 * DESIGN §2 word-for-word: the mark on the left, then the five-line masthead,
 * then the issuing branch's own address and phone beneath. Jost (weight 900) is
 * for the display lines only; the bar and the tagline stay Inter.
 */
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
        <div className="flex items-start gap-3">
          <img
            src="/logo.png"
            alt="7 Star"
            className="mt-0.5 size-14 shrink-0 object-contain print:size-16"
          />

          <div className="leading-none">
            <p className="font-display text-[28px] font-black tracking-wide text-black print:text-[30px]">
              LAPTOP
            </p>
            <p className="font-display text-[28px] font-black tracking-wide text-black print:text-[30px]">
              BATTERY STATION
            </p>
            <p className="mt-1.5 inline-block bg-[#3d78e6] px-2 py-0.5 text-[12px] font-bold tracking-wide text-white">
              A HOUSE OF LAPTOP BATTERIES
            </p>
            <p className="font-display mt-1.5 text-[18px] font-black uppercase tracking-wide text-black">
              Best Quality Best Price
            </p>
            <p className="mt-0.5 text-[12px] font-bold uppercase tracking-wide text-[#dc2626]">
              Laptop Battery Specialist in Pakistan
            </p>
          </div>
        </div>

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
