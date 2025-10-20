import { Link, useLocation } from '@tanstack/react-router';
import { Button } from '@heroui/react';
import { RefreshCw } from 'lucide-react';
import { useMutation } from '@tanstack/react-query';
import { http } from '@/clients/http';
import { useState } from 'react';

export function Navbar() {
  const location = useLocation();
  const [isRefreshing, setIsRefreshing] = useState(false);
  
  // Check if we're on a player profile page (/$region/$name/$tag pattern)
  const pathParts = location.pathname.split('/').filter(Boolean);
  const isPlayerProfilePage = pathParts.length === 3 && !pathParts[0].startsWith('queue');
  
  const refreshMutation = useMutation({
    mutationFn: async () => {
      // Extract region, name, and tag from URL
      const [region, name, tag] = pathParts;
      if (!region || !name || !tag) throw new Error('Invalid player profile URL');
      
      // Trigger partial scan with force=false (partial scan)
      const res = await http.post(
        `/v1/${region}/${name}/${tag}/rewind?force=false`
      );
      return res.data;
    },
    onSuccess: () => {
      setIsRefreshing(false);
      // Optionally show success message or redirect
    },
    onError: (err) => {
      setIsRefreshing(false);
      console.error('Failed to refresh rewind:', err);
    },
  });

  const handleRefresh = () => {
    setIsRefreshing(true);
    refreshMutation.mutate();
  };

  return (
    <nav className="relative z-50 border-b border-neutral-700/50 bg-neutral-900/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-blue-500 to-accent-blue-600" />
            <span className="text-xl font-bold text-neutral-50">Riftcoach</span>
          </Link>
          
          {isPlayerProfilePage && (
            <Button
              size="sm"
              variant="ghost"
              className="text-neutral-300 hover:text-white hover:bg-neutral-800"
              startContent={<RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />}
              onPress={handleRefresh}
              isDisabled={isRefreshing}
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh Data'}
            </Button>
          )}
        </div>
      </div>
    </nav>
  );
}