import { http } from '@/clients/http';
import { Navbar } from '@/components/navbar';
import { RewindForm } from '@/components/rewind-form';
import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

export const Route = createFileRoute('/')({
  head: () => {
    const title = 'Riftcoach | League of Legends Year in Review';
    const description =
      'Generate your personalized League of Legends rewind with Riftcoach. Analyze your matches, uncover strengths, and plan your next climb.';

    return {
      meta: [
        {
          title,
        },
        {
          name: 'description',
          content: description,
        },
        {
          property: 'og:title',
          content: title,
        },
        {
          property: 'og:description',
          content: description,
        },
      ],
    };
  },
  component: App,
});

// Role icon helper (same logic as champions page)
const getRoleIconUrl = (roleKey: string) => {
  if (roleKey === 'ALL')
    return 'https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-fill.png';
  return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-clash/global/default/assets/images/position-selector/positions/icon-position-${roleKey.toLowerCase()}.png`;
};

function App() {
  type Player = {
    name: string;
    position: string;
    summonerName: string;
    summonerTag: string;
    region: string;
    image: string;
  };

  type Team = {
    team: string;
    slug: string;
    players: Player[];
  };

  const { data: teams } = useQuery({
    queryKey: ['esports-teams'],
    queryFn: async () => {
      const res = await http.get<Team[]>('/v1/esports/teams');
      return res.data;
    },
  });

  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);

  const teamCards = useMemo(() => {
    return (teams ?? []).map((t) => (
      <button
        type="button"
        key={t.slug}
        className="group relative rounded-xl border border-neutral-700/50 bg-neutral-800/50 p-6 hover:bg-neutral-800 transition-colors"
        onClick={() => setSelectedTeam(t)}
      >
        <div className="flex items-center gap-4">
          <img
            src={`https://d1wwggj2y1tr8j.cloudfront.net/${t.slug}/logo.png`}
            alt={`${t.team} logo`}
            className="size-20 object-contain"
            loading="lazy"
          />
          <div>
            <div className="text-lg font-semibold text-neutral-50">
              {t.team}
            </div>
            <div className="text-xs text-neutral-400">
              {t.players.length} players
            </div>
          </div>
        </div>
      </button>
    ));
  }, [teams]);

  return (
    <div className="dark min-h-screen bg-gradient-to-br from-neutral-900 via-neutral-800 to-neutral-900 relative">
      {/* Subtle dotted background pattern */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(148, 163, 184, 0.3) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      <Navbar />

      {/* Hero Section */}
      <section className="relative overflow-hidden min-h-[70vh]">
        {/* Animated Background */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-secondary/10" />
          <div
            className="absolute left-1/4 top-1/4 h-96 w-96 rounded-full bg-primary/20 blur-3xl animate-pulse"
            style={{ animationDuration: '4s' }}
          />
          <div
            className="absolute right-1/4 bottom-1/4 h-96 w-96 rounded-full bg-secondary/20 blur-3xl animate-pulse delay-1000"
            style={{ animationDuration: '4s' }}
          />
          <div className="absolute left-1/2 top-1/2 h-[800px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-primary/5 to-secondary/5 blur-3xl" />
        </div>

        <div className="relative z-10 mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 lg:px-8">
          <div className="text-center">
            <h1 className="text-6xl font-bold text-neutral-50">Riftcoach</h1>
            <p className="text-xl text-neutral-300 max-w-2xl mx-auto">
              Your League of Legends Year in Review
            </p>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-neutral-300 sm:text-xl">
              Discover your journey on the Rift. Analyze your performance,
              celebrate your victories, and unlock insights to dominate the next
              season.
            </p>

            {/* CTA Form */}
            <div className="mt-12 flex justify-center">
              <div className="w-full max-w-3xl">
                <RewindForm />
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Esports Teams */}
      <section id="teams" className="relative">
        <div className="relative z-10 mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
          <div className="mb-8 text-center justify-center flex flex-col items-center gap-4">
            <img
              src="/lol-esports/WORLDS2025.webp"
              alt="Worlds 2025 logo"
              className="w-auto h-22"
              loading="lazy"
            />
            <p className="mt-2 text-neutral-300">
              Browse pro rosters and jump into player profiles.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6">
            {teamCards}
          </div>
        </div>
      </section>

      {/* Team Players Modal */}
      {selectedTeam && (
        <div className="fixed inset-0 z-50">
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            role="button"
            tabIndex={0}
            aria-label="Close modal"
            onClick={() => setSelectedTeam(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
                setSelectedTeam(null);
              }
            }}
          />
          <div
            className="absolute left-1/2 top-1/2 w-[95vw] max-w-3xl -translate-x-1/2 -translate-y-1/2 rounded-xl border border-neutral-700/60 bg-neutral-900/90 shadow-xl"
            // biome-ignore lint/a11y/useSemanticElements: needs to be a div
            role="dialog"
            aria-modal="true"
            aria-labelledby={`team-modal-title-${selectedTeam.slug}`}
          >
            <div className="flex items-center justify-between border-b border-neutral-700/50 px-6 py-4">
              <div className="flex items-center gap-3">
                <img
                  src={`https://d1wwggj2y1tr8j.cloudfront.net/${selectedTeam.slug}/logo.png`}
                  alt={`${selectedTeam.team} logo`}
                  className="h-8 w-8 rounded-md object-contain bg-neutral-800"
                />
                <h3
                  id={`team-modal-title-${selectedTeam.slug}`}
                  className="text-lg font-semibold text-neutral-50"
                >
                  {selectedTeam.team}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedTeam(null)}
                className="rounded-md px-3 py-1 text-sm text-neutral-300 hover:text-neutral-50 hover:bg-neutral-800"
              >
                Close
              </button>
            </div>
            <div className="px-6 py-5">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {selectedTeam.players.map((p) => (
                  <Link
                    key={`${selectedTeam.slug}-${p.summonerName}-${p.summonerTag}`}
                    to="/$region/$name/$tag"
                    params={{
                      region: p.region,
                      name: p.summonerName,
                      tag: p.summonerTag,
                    }}
                    aria-label={`Open ${p.name} profile`}
                    className="group relative overflow-hidden rounded-xl border border-neutral-700/60 bg-neutral-900/70 hover:bg-neutral-800/80 transition-all shadow-soft-lg h-28 sm:h-36"
                    preload="intent"
                  >
                    {/* Background team logo for subtle branding */}
                    <img
                      src={`https://d1wwggj2y1tr8j.cloudfront.net/${selectedTeam.slug}/logo.png`}
                      alt="team logo background"
                      className="pointer-events-none absolute left-0 top-0 h-full w-1/2 object-contain opacity-10 grayscale"
                    />

                    {/* Player portrait on the right with gradient fade */}
                    <img
                      src={`https://d1wwggj2y1tr8j.cloudfront.net/${selectedTeam.slug}/${p.image}`}
                      alt={`${p.name}`}
                      loading="lazy"
                      className="pointer-events-none absolute right-0 top-0 h-full w-[42%] object-cover object-center z-20"
                    />
                    <div className="absolute inset-y-0 right-0 w-[42%] bg-gradient-to-l from-neutral-900 via-neutral-900/80 to-transparent" />

                    {/* Role icon */}
                    <img
                      src={getRoleIconUrl(p.position)}
                      alt={`${p.position} role icon`}
                      className="absolute left-3 top-3 h-5 w-5 rounded-sm border border-neutral-700 bg-neutral-800/80"
                    />

                    {/* Content */}
                    <div className="relative z-10 flex h-full items-center pl-12 pr-4">
                      <div className="flex-1">
                        <div className="text-xl sm:text-2xl font-bold text-neutral-50 tracking-tight">
                          {p.name}
                        </div>
                        <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-300">
                          {p.summonerName}
                        </div>
                        <div className="mt-2 text-xs text-neutral-400">
                          {p.position} • {p.summonerName}#{p.summonerTag}
                        </div>
                        <div className="mt-1 text-xs text-neutral-500 group-hover:text-neutral-300">
                          View profile
                        </div>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer
        id="about"
        className="border-t border-neutral-700/50 bg-neutral-900/80 backdrop-blur-md"
      >
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center space-x-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-blue-500 to-accent-blue-600" />
                <span className="text-xl font-bold text-neutral-50">
                  Riftcoach
                </span>
              </div>
              <p className="mt-4 text-sm text-neutral-300 max-w-md">
                Your ultimate companion for League of Legends performance
                analysis. Built for the hackathon with cutting-edge AWS AI
                technology.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-neutral-50">
                Features
              </h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a
                    href="#features"
                    className="text-sm text-neutral-300 hover:text-neutral-50 transition-colors"
                  >
                    Year Review
                  </a>
                </li>
                <li>
                  <a
                    href="#features"
                    className="text-sm text-neutral-300 hover:text-neutral-50 transition-colors"
                  >
                    Match Analysis
                  </a>
                </li>
                <li>
                  <a
                    href="#features"
                    className="text-sm text-neutral-300 hover:text-neutral-50 transition-colors"
                  >
                    AI Insights
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-neutral-50">Support</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a
                    href="#about"
                    className="text-sm text-neutral-300 hover:text-neutral-50 transition-colors"
                  >
                    Documentation
                  </a>
                </li>
                <li>
                  <a
                    href="#about"
                    className="text-sm text-neutral-300 hover:text-neutral-50 transition-colors"
                  >
                    Contact
                  </a>
                </li>
                <li>
                  <a
                    href="#about"
                    className="text-sm text-neutral-300 hover:text-neutral-50 transition-colors"
                  >
                    Status
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-8 border-t border-neutral-700/50 pt-8">
            <p className="text-center text-sm text-neutral-300">
              © 2024 Riftcoach. Built for the hackathon with ❤️ and AWS AI.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
