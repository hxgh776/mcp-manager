import type { ReactNode } from 'react';

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-5 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      {(title !== undefined || actions !== undefined) && (
        <div className="mb-3 flex items-center justify-between">
          {title !== undefined && <h2 className="font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Btn(props: {
  children: ReactNode;
  onClick?: () => void;
  kind?: 'primary' | 'default' | 'danger';
  disabled?: boolean;
  testId?: string;
  small?: boolean;
}) {
  const cls =
    props.kind === 'primary'
      ? 'bg-blue-600 text-white hover:bg-blue-700'
      : props.kind === 'danger'
        ? 'bg-red-600 text-white hover:bg-red-700'
        : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50';
  return (
    <button
      data-testid={props.testId}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`rounded ${props.small === true ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'} font-medium disabled:opacity-50 ${cls}`}
    >
      {props.children}
    </button>
  );
}

export function Badge({ tone, children }: { tone: 'green' | 'red' | 'gray' | 'blue' | 'amber'; children: ReactNode }) {
  const map = {
    green: 'bg-green-100 text-green-700',
    red: 'bg-red-100 text-red-700',
    gray: 'bg-slate-100 text-slate-600',
    blue: 'bg-blue-100 text-blue-700',
    amber: 'bg-amber-100 text-amber-700',
  } as const;
  return <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${map[tone]}`}>{children}</span>;
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-3 block text-sm">
      <span className="mb-1 block font-medium text-slate-700">{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span className="mt-1 block text-xs text-slate-400">{props.hint}</span>}
    </label>
  );
}

export const inputCls =
  'w-full rounded border border-slate-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none';

export function ErrorBanner({ message }: { message: string | null }) {
  if (message === null || message === '') return null;
  return <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">{message}</div>;
}

export function OkBanner({ message }: { message: string | null }) {
  if (message === null || message === '') return null;
  return <div className="mb-4 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">{message}</div>;
}
