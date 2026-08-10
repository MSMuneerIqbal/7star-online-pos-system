import { Construction, FileQuestion, Hammer } from 'lucide-react';

const COPY: Record<string, { icon: typeof Hammer; title: string; body: string }> = {
  ported: {
    icon: Hammer,
    title: 'Not migrated yet',
    body: 'This screen exists in the legacy ASP.NET system and is scheduled for migration. See PLAN.md for its phase.',
  },
  stub: {
    icon: Construction,
    title: 'Incomplete in the legacy system',
    body: 'The legacy screen was never finished — its form has no save action. This workflow needs designing before it can be built.',
  },
  new: {
    icon: FileQuestion,
    title: 'Never built',
    body: 'This was linked in the legacy sidebar but the controller never existed, so it returned a 404. It is new work in this rewrite.',
  },
};

export function NotBuiltPage({ title, status }: { title: string; status: string }) {
  const { icon: Icon, title: heading, body } = COPY[status] ?? COPY.new!;

  return (
    <div className="card mx-auto mt-12 max-w-lg p-8 text-center">
      <Icon className="mx-auto mb-3 size-8 text-slate-400" />
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      <p className="mt-1 text-sm font-medium text-slate-500">{heading}</p>
      <p className="mt-3 text-sm text-slate-600">{body}</p>
    </div>
  );
}
