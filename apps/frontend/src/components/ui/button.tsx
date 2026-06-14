import * as React from 'react';
import { cn } from '../../lib/utils';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
};

export function Button({ className, variant = 'primary', ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-primary text-slate-950 hover:bg-teal-300',
        variant === 'secondary' && 'border border-border bg-white/5 text-foreground hover:bg-white/10',
        variant === 'danger' && 'bg-rose-500 text-white hover:bg-rose-400',
        className,
      )}
      {...props}
    />
  );
}
