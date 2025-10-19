import { RewindForm } from '@/components/rewind-form';
import { Card, CardBody, CardHeader } from '@heroui/react';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/')({
  component: App,
});

function App() {
  return (
    <div className="dark min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 relative">
      {/* Subtle dotted background pattern */}
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            'radial-gradient(circle, rgba(148, 163, 184, 0.3) 1px, transparent 1px)',
          backgroundSize: '20px 20px',
        }}
      />
      {/* Navigation Header */}
      <nav className="relative z-50 border-b border-slate-700/50 bg-slate-800/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600" />
              <span className="text-xl font-bold text-white">Riftcoach</span>
            </div>
            <div className="hidden md:flex items-center space-x-8">
              <a
                href="/"
                className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                Home
              </a>
              <a
                href="#features"
                className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                Features
              </a>
              <a
                href="#about"
                className="text-sm font-medium text-slate-300 hover:text-white transition-colors"
              >
                About
              </a>
            </div>
          </div>
        </div>
      </nav>

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
            <h1 className="text-6xl font-bold text-white">Riftcoach</h1>
            <p className="text-xl text-slate-300 max-w-2xl mx-auto">
              Your League of Legends Year in Review
            </p>
            <p className="mx-auto mt-6 max-w-2xl text-lg leading-8 text-slate-300 sm:text-xl">
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

      {/* Footer */}
      <footer
        id="about"
        className="border-t border-slate-700/50 bg-slate-800/80 backdrop-blur-md"
      >
        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
            <div className="col-span-1 md:col-span-2">
              <div className="flex items-center space-x-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600" />
                <span className="text-xl font-bold text-white">Riftcoach</span>
              </div>
              <p className="mt-4 text-sm text-slate-300 max-w-md">
                Your ultimate companion for League of Legends performance
                analysis. Built for the hackathon with cutting-edge AWS AI
                technology.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Features</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a
                    href="#features"
                    className="text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    Year Review
                  </a>
                </li>
                <li>
                  <a
                    href="#features"
                    className="text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    Match Analysis
                  </a>
                </li>
                <li>
                  <a
                    href="#features"
                    className="text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    AI Insights
                  </a>
                </li>
              </ul>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">Support</h3>
              <ul className="mt-4 space-y-2">
                <li>
                  <a
                    href="#about"
                    className="text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    Documentation
                  </a>
                </li>
                <li>
                  <a
                    href="#about"
                    className="text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    Contact
                  </a>
                </li>
                <li>
                  <a
                    href="#about"
                    className="text-sm text-slate-300 hover:text-white transition-colors"
                  >
                    Status
                  </a>
                </li>
              </ul>
            </div>
          </div>
          <div className="mt-8 border-t border-slate-700/50 pt-8">
            <p className="text-center text-sm text-slate-300">
              © 2024 Riftcoach. Built for the hackathon with ❤️ and AWS AI.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
