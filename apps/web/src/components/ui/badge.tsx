import type { HTMLAttributes } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-accent-blue-500',
  {
    variants: {
      variant: {
        default: 'border-slate-600 bg-slate-800/80 text-slate-100',
        secondary: 'border-accent-blue-400 bg-accent-blue-500/20 text-accent-blue-200',
        destructive: 'border-red-500/80 bg-red-500/10 text-red-400',
        success: 'border-emerald-500/80 bg-emerald-500/10 text-emerald-300',
        outline: 'border-slate-600 text-slate-200',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
