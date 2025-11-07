import { cn } from '@/lib/utils';
import { Link, useRouterState } from '@tanstack/react-router';
import { Crown, Snowflake, Swords, User } from 'lucide-react';

interface ProfileTabsProps {
  region: string;
  name: string;
  tag: string;
}

export function ProfileTabs({ region, name, tag }: ProfileTabsProps) {
  const router = useRouterState();
  const currentPath = router.location.pathname;

  // Encode the parameters to match the URL encoding in the pathname
  const encodedRegion = encodeURIComponent(region);
  const encodedName = encodeURIComponent(name);
  const encodedTag = encodeURIComponent(tag);

  const tabs = [
    {
      id: 'profile',
      label: 'Overview',
      icon: User,
      path: `/${encodedRegion}/${encodedName}/${encodedTag}`,
    },
    {
      id: 'matches',
      label: 'Matches',
      icon: Swords,
      path: `/${encodedRegion}/${encodedName}/${encodedTag}/matches`,
    },
    {
      id: 'champions',
      label: 'Champions',
      icon: Crown,
      path: `/${encodedRegion}/${encodedName}/${encodedTag}/champions`,
    },
    {
      id: 'aram',
      label: 'ARAM',
      icon: Snowflake,
      path: `/${encodedRegion}/${encodedName}/${encodedTag}/aram`,
    },
  ];

  const isActiveTab = (tabPath: string) => {
    if (tabPath === `/${encodedRegion}/${encodedName}/${encodedTag}`) {
      // For the profile tab, it should be active only on the exact path
      return currentPath === tabPath;
    }
    // For other tabs, check if the current path starts with the tab path
    return currentPath.startsWith(tabPath);
  };

  return (
    <div className="border-b border-neutral-800/50">
      <nav className="flex space-x-8" aria-label="Profile navigation">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = isActiveTab(tab.path);

          return (
            <Link
              key={tab.id}
              to={tab.path}
              className={cn(
                'group inline-flex items-center px-1 py-4 border-b-2 font-medium text-sm transition-all duration-200',
                isActive
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200 hover:border-neutral-600',
              )}
            >
              <Icon
                className={cn(
                  'mr-2 h-4 w-4 transition-colors duration-200',
                  isActive
                    ? 'text-blue-400'
                    : 'text-neutral-500 group-hover:text-neutral-300',
                )}
              />
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
