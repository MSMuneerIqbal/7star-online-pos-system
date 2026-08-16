/**
 * The masthead — the mark, then the five brand lines, word for word and weight
 * for weight as the website sets them (DESIGN §2).
 *
 * It appears in exactly TWO places: the login screen, and the header of every
 * printed document. Nowhere else — a five-line masthead above an invoice grid is
 * wasted counter space, which is why the app header carries the mark and the
 * branch name only.
 *
 * Jost 900 is for the display lines. The blue bar and the red tagline stay
 * Inter, and Jost never touches data.
 */
interface MastheadProps {
  /**
   * `print` sits left-aligned beside the document's number and date.
   * `login` stands alone and centred, so it reads as the front door.
   */
  variant?: 'print' | 'login';
}

export function Masthead({ variant = 'print' }: MastheadProps) {
  const isLogin = variant === 'login';

  return (
    <div className={isLogin ? 'flex flex-col items-center gap-3' : 'flex items-start gap-3'}>
      <img
        src="/logo.png"
        alt="7 Star"
        className={
          isLogin
            ? 'size-16 shrink-0 object-contain'
            : 'mt-0.5 size-14 shrink-0 object-contain print:size-16'
        }
      />

      <div className={isLogin ? 'text-center leading-none' : 'leading-none'}>
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
  );
}
