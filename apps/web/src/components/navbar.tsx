import { Link } from '@tanstack/react-router';

export function Navbar() {
  return (
    <nav className="relative z-50 border-b border-neutral-700/50 bg-neutral-900/80 backdrop-blur-md">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <Link to="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-accent-blue-500 to-accent-blue-600" />
            <span className="text-xl font-bold text-neutral-50">Riftcoach</span>
          </Link>
        </div>
      </div>
    </nav>
  );
}