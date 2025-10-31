import { Card, CardBody } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import type { RewindStatusResponse } from '@/routes/$region/$name/$tag';
import { motion } from 'framer-motion';
import { Loader2, X } from 'lucide-react';
import { useState } from 'react';

interface ScanStatusBoxProps {
  status: RewindStatusResponse;
  wsConnected: boolean;
  onClose?: () => void;
}

export function ScanStatusBox({
  status,
  wsConnected,
  onClose,
}: ScanStatusBoxProps) {
  const [isVisible, setIsVisible] = useState(true);

  const progressPercentage =
    status.total > 0
      ? Math.min((status.processed / status.total) * 100, 100)
      : 0;

  const handleClose = () => {
    setIsVisible(false);
    onClose?.();
  };

  if (!isVisible) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: -100 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -100 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      className="fixed top-18 right-4 z-50 w-80"
    >
      <Card className="bg-neutral-800/95 backdrop-blur-sm border-neutral-700 shadow-xl py-0">
        <CardBody className="p-4">
          <div className="space-y-3">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    wsConnected ? 'bg-green-400 animate-pulse' : 'bg-cyan-400'
                  }`}
                />
                <span className="text-sm font-medium text-neutral-200">
                  Scan in Progress
                </span>
              </div>
              <button
                type="button"
                onClick={handleClose}
                className="p-1 rounded-md hover:bg-neutral-700 transition-colors"
                aria-label="Close scan status"
              >
                <X className="w-4 h-4 text-neutral-400" />
              </button>
            </div>

            {/* Progress */}
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-neutral-300">
                <span>{Math.round(progressPercentage)}% Complete</span>
                <span className="capitalize">{status.status}</span>
              </div>
              <Progress
                value={progressPercentage}
                className="h-2"
                aria-label="Scan progress"
              />
              <div className="text-xs text-neutral-400 text-center">
                {status.processed} of {status.total} matches processed
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-sm font-semibold text-cyan-400">
                  {status.total}
                </div>
                <div className="text-xs text-neutral-400">Found</div>
              </div>
              <div>
                <div className="text-sm font-semibold text-cyan-400">
                  {status.processed}
                </div>
                <div className="text-xs text-neutral-400">Processed</div>
              </div>
              <div>
                <div className="text-sm font-semibold text-cyan-400">
                  {status.position ?? '-'}
                </div>
                <div className="text-xs text-neutral-400">Queue</div>
              </div>
            </div>

            {/* Status indicator */}
            <div className="flex items-center justify-center gap-2 pt-1">
              <Loader2 className="w-3 h-3 text-cyan-400 animate-spin" />
              <span className="text-xs text-neutral-300">
                {status.status === 'listing'
                  ? 'Finding matches...'
                  : 'Analyzing matches...'}
              </span>
            </div>
          </div>
        </CardBody>
      </Card>
    </motion.div>
  );
}
