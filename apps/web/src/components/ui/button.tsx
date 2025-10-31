import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ring-offset-background',
  {
    variants: {
      variant: {
        default:
          'bg-slate-800 text-slate-100 hover:bg-slate-700 border border-slate-600 shadow-soft px-4 py-2',
        secondary:
          'bg-accent-blue-600/90 text-white hover:bg-accent-blue-500 border border-accent-blue-400/80 shadow-soft px-4 py-2',
        ghost:
          'bg-transparent border border-transparent hover:bg-slate-800/60 hover:text-white text-slate-200',
        outline:
          'border border-slate-600 bg-transparent text-slate-200 hover:bg-slate-800/60',
        flat:
          'bg-slate-800/70 text-slate-200 hover:bg-slate-700/70 border border-slate-700/70',
        destructive:
          'bg-red-600 text-white hover:bg-red-500 border border-red-500/80',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-9 rounded-md px-3',
        lg: 'h-12 rounded-md px-6 text-base',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
