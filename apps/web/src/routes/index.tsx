import { RewindForm } from '@/components/rewind-form';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: App,
});

function App() {
  return (
    <div className="dark min-h-screen bg-background">
      <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4">
        {/* Subtle gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />
        <div className="absolute left-1/2 top-1/2 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary/10 blur-3xl" />

        <div className="relative z-10 w-full max-w-2xl space-y-8 text-center">
          {/* Logo/Brand */}
          <div className="space-y-2">
            <h1 className="text-balance font-sans text-5xl font-bold tracking-tight text-foreground md:text-7xl">
              League of Legends
              <span className="block bg-gradient-to-r from-primary to-accent bg-clip-text text-transparent">
                Rewind
              </span>
            </h1>
            <p className="text-pretty text-lg text-muted-foreground md:text-xl">
              Relive your greatest moments on the Rift
            </p>
          </div>

          {/* Form */}
          <RewindForm />

          {/* Footer text */}
          <p className="text-sm text-muted-foreground">
            Discover your stats, achievements, and memorable plays from the
            season
          </p>
        </div>
      </div>
    </div>
  );
}
