'use client';

import type React from 'react';

import { http } from '@/clients/http';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNavigate } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';

const REGIONS = [
  { value: 'na1', label: 'NA' },
  { value: 'euw1', label: 'EUW' },
  { value: 'eun1', label: 'EUN' },
  { value: 'kr', label: 'KR' },
  { value: 'br1', label: 'BR' },
  { value: 'la1', label: 'LA1' },
  { value: 'la2', label: 'LA2' },
  { value: 'oc1', label: 'OC' },
  { value: 'ru', label: 'RU' },
  { value: 'tr1', label: 'TR' },
  { value: 'jp1', label: 'JP' },
];

export function RewindForm() {
  const navigate = useNavigate({ from: '/' });
  const [region, setRegion] = useState('');
  const [summonerName, setSummonerName] = useState('');
  const [tagline, setTagline] = useState('');
  const [error, setError] = useState<string | null>(null);

  interface StartRewindResponse {
    rewindId: string;
  }

  const startRewindMutation = useMutation({
    mutationKey: ['start-rewind', region, summonerName, tagline],
    mutationFn: async (): Promise<StartRewindResponse> => {
      if (!region || !summonerName || !tagline) {
        throw new Error('Region, summoner name and tagline are required');
      }
      
      // First check if player already has a completed rewind
      try {
        const statusRes = await http.get<{
          rewindId: string;
          status: string;
          matches: number;
          processed: number;
          total: number;
        }>(
          `/v1/${encodeURIComponent(region)}/${encodeURIComponent(summonerName)}/${encodeURIComponent(tagline)}/rewind`,
        );
        
        // If player has a completed rewind, redirect to the overview page
        if (statusRes.data.status === 'completed' && statusRes.data.rewindId) {
          navigate({
            to: '/$region/$name/$tag',
            params: {
              region,
              name: summonerName,
              tag: tagline,
            },
          });
          return { rewindId: statusRes.data.rewindId };
        }
      } catch (err) {
        // If no existing rewind found, continue with new rewind
        console.log('No existing rewind found, creating new one');
      }
      
      const res = await http.post<StartRewindResponse>(
        `/v1/${encodeURIComponent(region)}/${encodeURIComponent(summonerName)}/${encodeURIComponent(tagline)}/rewind`,
      );
      return res.data;
    },
    onSuccess: (data) => {
      // Only navigate to status page if we created a new rewind
      if (data.rewindId) {
        navigate({
          to: '/$region/$name/$tag',
          params: {
            region,
            name: summonerName,
            tag: tagline,
          },
        });
      }
    },
    onError: (err) => {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setError(message);
      console.error('Failed to start rewind:', err);
    },
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await startRewindMutation.mutateAsync();
    } catch (err) {
      // Error already handled in onError, but ensure no unhandled rejection
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex flex-col gap-4 rounded-xl border border-divider bg-content1/50 p-6 backdrop-blur-sm md:flex-row md:items-center md:p-8">
        {/* Region Select */}
        <div className="flex-shrink-0 space-y-2 md:w-48">
          <Select
            value={region}
            onValueChange={(value) => {
              setRegion(value);
            }}
          >
            <SelectTrigger className="h-12 w-full border-slate-600 bg-slate-900/70 text-slate-100">
              <SelectValue placeholder="Select region" />
            </SelectTrigger>
            <SelectContent className="bg-slate-900 text-slate-100">
              {REGIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 space-y-2">
          <div className="flex h-12 items-center rounded-lg border border-slate-600 bg-slate-800/50 focus-within:border-cyan-400 focus-within:ring-1 focus-within:ring-cyan-400 transition-all">
            <Input
              placeholder="Summoner"
              value={summonerName}
              onChange={(event) => setSummonerName(event.target.value)}
              className="flex-1 border-0 bg-transparent hover:bg-transparent focus-visible:ring-0"
              required
            />
            <div className="flex items-center px-3 text-slate-400 font-mono text-lg">
              #
            </div>
            <Input
              placeholder="EUW"
              value={tagline}
              onChange={(event) => setTagline(event.target.value)}
              className="w-20 border-0 bg-transparent focus-visible:ring-0"
              required
            />
          </div>
        </div>

        {/* Submit Button */}
        <div className="flex flex-col gap-2">
          <Button
            type="submit"
            size="lg"
            variant="flat"
            className="h-12 flex-shrink-0 bg-slate-700 hover:bg-slate-600 border border-slate-600 hover:border-slate-500 px-8 text-base font-medium text-slate-200 hover:text-white transition-all duration-200 md:w-auto"
            disabled={
              startRewindMutation.isPending ||
              !region ||
              !summonerName ||
              !tagline
            }
          >
            <span className="flex items-center gap-2">
              <Sparkles className={`h-5 w-5 ${startRewindMutation.isPending ? 'animate-pulse' : ''}`} />
              {startRewindMutation.isPending ? 'Starting…' : 'Start Rewind'}
            </span>
          </Button>
          {error && (
            <div className="text-sm text-red-400">{error}</div>
          )}
        </div>
      </div>
    </form>
  );
}
