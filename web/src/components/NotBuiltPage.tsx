import { FileQuestion } from 'lucide-react';

export function NotBuiltPage({ title }: { title: string; status?: string }) {
  return (
    <div className="card mx-auto mt-12 max-w-lg p-8 text-center">
      <FileQuestion className="mx-auto mb-3 size-8 text-slate-400" />
      <h1 className="text-lg font-semibold text-slate-900">{title}</h1>
      <p className="mt-3 text-sm text-slate-600">
        This page is not available. Check the address and try again.
      </p>
    </div>
  );
}
