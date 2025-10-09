'use client';

import type React from 'react';

import { http } from '@/clients/http';
import { Button, Input, Select, SelectItem } from '@heroui/react';
import { useNavigate } from '@tanstack/react-router';
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
      <div className="flex flex-col gap-4 rounded-xl border border-divider bg-content1/50 p-6 backdrop-blur-sm md:flex-row md:items-end md:p-8">
        {/* Region Select */}
        <div className="flex-shrink-0 space-y-2 md:w-48">
          <Select
            placeholder="Select region"
            selectedKeys={region ? [region] : []}
            onSelectionChange={(keys) => {
              const selected = Array.from(keys)[0] as string;
              setRegion(selected);
            }}
            className="w-full"
            size="lg"
          >
            {REGIONS.map((r) => (
              <SelectItem key={r.value}>{r.label}</SelectItem>
            ))}
          </Select>
        </div>

        <div className="flex-1 space-y-2">
          <div className="flex rounded-lg border border-slate-600 bg-slate-800/50 focus-within:border-cyan-400 focus-within:ring-1 focus-within:ring-cyan-400 transition-all">
            <Input
              placeholder="Summoner"
              value={summonerName}
              onValueChange={setSummonerName}
              className="flex-1 border-0 bg-transparent hover:bg-transparent"
              size="lg"
              isRequired
              classNames={{
                input: 'bg-transparent border-0 focus:ring-0',
                inputWrapper:
                  'bg-transparent border-0 shadow-none hover:bg-transparent group-data-[focus=true]:bg-transparent',
                label: 'text-slate-300',
                base: 'bg-transparent border-0 focus:ring-0',
              }}
            />
            <div className="flex items-center px-3 text-slate-400 font-mono text-lg">
              #
            </div>
            <Input
              placeholder="EUW"
              value={tagline}
              onValueChange={setTagline}
              className="w-20 border-0 bg-transparent"
              size="lg"
              isRequired
              classNames={{
                input: 'bg-transparent border-0 focus:ring-0',
                inputWrapper:
                  'bg-transparent border-0 shadow-none hover:bg-transparent group-data-[focus=true]:bg-transparent',
                label: 'text-slate-300',
                base: 'bg-transparent border-0 focus:ring-0',
              }}
            />
          </div>
        </div>

        {/* Submit Button */}
        <Button
          type="submit"
          size="lg"
          className="h-12 flex-shrink-0 bg-slate-700 hover:bg-slate-600 border border-slate-600 hover:border-slate-500 px-8 text-base font-medium text-slate-200 hover:text-white transition-all duration-200 md:w-auto"
          startContent={<Sparkles className="h-5 w-5" />}
        >
          Start Rewind
        </Button>
      </div>
    </form>
  );
}
