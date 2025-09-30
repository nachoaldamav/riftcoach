'use client';

import type React from 'react';

import { http } from '@/clients/http';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useNavigate } from '@tanstack/react-router';
import { Sparkles } from 'lucide-react';
import { useState } from 'react';

const REGIONS = [
  { value: 'na1', label: 'North America' },
  { value: 'euw1', label: 'Europe West' },
  { value: 'eun1', label: 'Europe Nordic & East' },
  { value: 'kr', label: 'Korea' },
  { value: 'br1', label: 'Brazil' },
  { value: 'la1', label: 'Latin America North' },
  { value: 'la2', label: 'Latin America South' },
  { value: 'oc1', label: 'Oceania' },
  { value: 'ru', label: 'Russia' },
  { value: 'tr1', label: 'Turkey' },
  { value: 'jp1', label: 'Japan' },
];

export function RewindForm() {
  const navigate = useNavigate({ from: '/' });
  const [region, setRegion] = useState('');
  const [summonerName, setSummonerName] = useState('');
  const [tagline, setTagline] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    console.log('Form submitted:', { region, summonerName, tagline });
    // Handle form submission
    const res = await http.post<{ jobId: string; position: number }>(
      '/rewind/start',
      {
        tagName: summonerName,
        tagLine: tagline,
        region: region,
      },
    );
    if (res.status === 200) {
      console.log('Rewind job started:', res.data);
      navigate({
        to: '/queue/$id',
        params: {
          id: res.data.jobId,
        },
      });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="w-full">
      <div className="flex flex-col gap-4 rounded-xl border border-border bg-card/50 p-6 backdrop-blur-sm md:flex-row md:items-end md:p-8">
        {/* Region Select */}
        <div className="flex-shrink-0 space-y-2 md:w-48">
          <Label
            htmlFor="region"
            className="text-sm font-medium text-card-foreground"
          >
            Region
          </Label>
          <Select value={region} onValueChange={setRegion}>
            <SelectTrigger
              id="region"
              className="h-12 w-full bg-secondary text-base"
            >
              <SelectValue placeholder="Select region" />
            </SelectTrigger>
            <SelectContent>
              {REGIONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex-1 space-y-2">
          <Label
            htmlFor="summoner-name"
            className="text-sm font-medium text-card-foreground"
          >
            Summoner Name & Tag
          </Label>
          <div className="flex h-12 overflow-hidden rounded-md border border-input bg-secondary">
            <Input
              id="summoner-name"
              type="text"
              placeholder="Summoner Name"
              value={summonerName}
              onChange={(e) => setSummonerName(e.target.value)}
              className="h-full flex-1 border-0 bg-transparent text-base focus-visible:ring-0 focus-visible:ring-offset-0"
              required
            />
            <div className="flex items-center border-l border-input/50 bg-secondary/50 px-3">
              <span className="text-base text-muted-foreground">#</span>
              <Input
                id="tagline"
                type="text"
                placeholder="NA1"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                className="h-full w-20 border-0 bg-transparent px-1 text-base focus-visible:ring-0 focus-visible:ring-offset-0"
                required
              />
            </div>
          </div>
        </div>

        {/* Submit Button */}
        <Button
          type="submit"
          size="lg"
          className="h-12 flex-shrink-0 bg-gradient-to-r from-primary to-accent px-8 text-base font-semibold text-primary-foreground hover:opacity-90 md:w-auto"
        >
          <Sparkles className="mr-2 h-5 w-5" />
          Start Rewind
        </Button>
      </div>
    </form>
  );
}
