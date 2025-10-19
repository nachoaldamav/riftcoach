import { cn } from '@/lib/utils';
import { motion } from 'framer-motion';

interface BentoGridProps {
  children: React.ReactNode;
  className?: string;
}

interface BentoItemProps {
  children: React.ReactNode;
  className?: string;
  span?: 'sm' | 'md' | 'lg' | 'xl';
}

export function BentoGrid({ children, className }: BentoGridProps) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className={cn(
        'grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8 w-full max-w-7xl mx-auto px-4',
        className,
      )}
    >
      {children}
    </motion.div>
  );
}

export function BentoItem({
  children,
  className,
  span = 'md',
}: BentoItemProps) {
  const spanClasses = {
    sm: 'md:col-span-1 lg:col-span-1 min-h-[280px]',
    md: 'md:col-span-1 lg:col-span-2 min-h-[320px]',
    lg: 'md:col-span-2 lg:col-span-4 min-h-[360px]',
    xl: 'md:col-span-2 lg:col-span-4 min-h-[400px]',
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 40 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: 0.5,
        type: 'spring',
        stiffness: 100,
        damping: 15,
      }}
      className={cn('relative group', spanClasses[span], className)}
    >
      <div className="flex flex-col justify-between h-full gap-4">
        {children}
      </div>
    </motion.div>
  );
}
