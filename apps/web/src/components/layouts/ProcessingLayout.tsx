import { Navbar } from '@/components/navbar';
import { ScanStatusBox } from '@/components/scan-status-box';
import { Loader2 } from 'lucide-react';
import type { RewindStatusResponse } from '@/routes/$region/$name/$tag';

interface ProcessingLayoutProps {
  region: string;
  status: RewindStatusResponse;
  wsConnected: boolean;
}

export function ProcessingLayout({ region, status, wsConnected }: ProcessingLayoutProps) {
  return (
    <div className="min-h-screen bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 dark relative">
      <Navbar />
      <div className="flex items-center justify-center min-h-[calc(100vh-64px)]">
        <div className="text-center space-y-4">
          <Loader2 className="w-12 h-12 text-cyan-400 animate-spin mx-auto" />
          <h2 className="text-2xl font-bold text-neutral-50">Analyzing your matches...</h2>
          <p className="text-neutral-300">
            We're gathering all your matches from {region.toUpperCase()} to create your personalized rewind
          </p>
        </div>
      </div>

      <ScanStatusBox status={status} wsConnected={wsConnected} />
    </div>
  );
}