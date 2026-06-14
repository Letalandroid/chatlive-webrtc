import * as React from 'react';
import { cn } from '../../lib/utils';

export function Input({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-11 w-full rounded-xl border border-border bg-slate-950/60 px-3 text-sm text-foreground outline-none ring-primary/30 transition placeholder:text-muted focus:ring-4',
        className,
      )}
      {...props}
    />
  );
}
