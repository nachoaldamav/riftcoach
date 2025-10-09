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
          backgroundImage: 'radial-gradient(circle, rgba(148, 163, 184, 0.3) 1px, transparent 1px)',
          backgroundSize: '20px 20px'
        }}
      />
      {/* Navigation Header */}
      <nav className="relative z-50 border-b border-slate-700/50 bg-slate-800/80 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600" />
              <span className="text-xl font-bold text-white">
                Riftcoach
              </span>
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
      <section className="relative overflow-hidden">
        {/* Animated Background */}
        <div className="absolute inset-0">
          <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-background to-secondary/10" />
          <div className="absolute left-1/4 top-1/4 h-96 w-96 rounded-full bg-primary/20 blur-3xl animate-pulse" style={{ animationDuration: '4s' }} />
          <div className="absolute right-1/4 bottom-1/4 h-96 w-96 rounded-full bg-secondary/20 blur-3xl animate-pulse delay-1000" style={{ animationDuration: '4s' }} />
          <div className="absolute left-1/2 top-1/2 h-[800px] w-[800px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-primary/5 to-secondary/5 blur-3xl" />
        </div>

        <div className="relative z-10 mx-auto max-w-7xl px-4 py-24 sm:px-6 sm:py-32 lg:px-8">
          <div className="text-center">
            <h1 className="text-6xl font-bold text-white">
              Riftcoach
            </h1>
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

      {/* Features Section */}
      <section id="features" className="py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
              Powered by Advanced Analytics
            </h2>
            <p className="mt-4 text-lg text-foreground/80">
              Get deep insights into your gameplay with AI-powered analysis
            </p>
          </div>

          <div className="mt-16 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <Card className="bg-slate-800/90 backdrop-blur-sm border-slate-700 shadow-xl hover:border-cyan-400/40 transition-colors">
              <CardHeader className="pb-3">
                <div className="flex items-center space-x-3">
                  <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
                    <svg
                      className="h-5 w-5 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-label="Year Review"
                    >
                      <title>Year Review</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    Year Review
                  </h3>
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-slate-300">
                  Comprehensive analysis of your entire season performance,
                  highlighting your growth and achievements.
                </p>
              </CardBody>
            </Card>

            <Card className="bg-slate-700/80 backdrop-blur-sm border-slate-600 shadow-xl hover:border-cyan-400/40 transition-colors">
              <CardHeader className="pb-3">
                <div className="flex items-center space-x-3">
                  <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
                    <svg
                      className="h-5 w-5 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-label="Match Analysis"
                    >
                      <title>Match Analysis</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M13 10V3L4 14h7v7l9-11h-7z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    Match Analysis
                  </h3>
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-slate-300">
                  Deep dive into specific matches with AI-powered insights
                  comparing your performance to your yearly average.
                </p>
              </CardBody>
            </Card>

            <Card className="bg-slate-600/70 backdrop-blur-sm border-slate-500 shadow-xl hover:border-cyan-400/40 transition-colors">
              <CardHeader className="pb-3">
                <div className="flex items-center space-x-3">
                  <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-cyan-500 to-cyan-600 flex items-center justify-center">
                    <svg
                      className="h-5 w-5 text-white"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      aria-label="AI Insights"
                    >
                      <title>AI Insights</title>
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"
                      />
                    </svg>
                  </div>
                  <h3 className="text-lg font-semibold text-white">
                    AI Insights
                  </h3>
                </div>
              </CardHeader>
              <CardBody>
                <p className="text-slate-300">
                  Powered by AWS AI tools to provide personalized
                  recommendations and strategic insights.
                </p>
              </CardBody>
            </Card>
          </div>
        </div>
      </section>

      {/* Stats Section */}
      <section className="bg-gradient-to-r from-slate-800/20 to-slate-700/20 py-24 sm:py-32">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
              Trusted by Summoners Worldwide
            </h2>
          </div>
          <div className="mt-16 grid grid-cols-2 gap-8 md:grid-cols-4">
            <div className="text-center">
              <div className="text-4xl font-bold text-cyan-400">10K+</div>
              <div className="mt-2 text-sm text-slate-300">
                Reviews Generated
              </div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-bold text-cyan-400">500K+</div>
              <div className="mt-2 text-sm text-slate-300">
                Matches Analyzed
              </div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-bold text-cyan-400">150+</div>
              <div className="mt-2 text-sm text-slate-300">
                Champions Covered
              </div>
            </div>
            <div className="text-center">
              <div className="text-4xl font-bold text-cyan-400">99.9%</div>
              <div className="mt-2 text-sm text-slate-300">Uptime</div>
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
                <span className="text-xl font-bold text-white">
                  Riftcoach
                </span>
              </div>
              <p className="mt-4 text-sm text-slate-300 max-w-md">
                Your ultimate companion for League of Legends performance
                analysis. Built for the hackathon with cutting-edge AWS AI
                technology.
              </p>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-white">
                Features
              </h3>
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
