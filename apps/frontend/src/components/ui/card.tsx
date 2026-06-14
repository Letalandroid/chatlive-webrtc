import * as React from 'react';
import { cn } from '../../lib/utils';

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-3xl border border-border bg-card/85 p-6 shadow-glow backdrop-blur', className)} {...props} />;
}
