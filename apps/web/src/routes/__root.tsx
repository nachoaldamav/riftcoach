import { TanstackDevtools } from '@tanstack/react-devtools';
import {
  HeadContent,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';

import TanStackQueryDevtools from '../integrations/tanstack-query/devtools';
import {
  championDataQueryOptions,
  versionsQueryOptions,
} from '../lib/data-dragon';
import { DataDragonProvider } from '../providers/data-dragon-provider';

import appCss from '../styles.css?url';

import type { QueryClient } from '@tanstack/react-query';

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  beforeLoad: async ({ context }) => {
    // Prefetch Data Dragon data
    const queryClient = context.queryClient;

    // Prefetch the latest version
    const versionPromise = queryClient.prefetchQuery(versionsQueryOptions);

    // Get the version and prefetch champion data
    const version = await queryClient.ensureQueryData(versionsQueryOptions);
    const championPromise = queryClient.prefetchQuery(
      championDataQueryOptions(version),
    );

    // Wait for both to complete
    await Promise.all([versionPromise, championPromise]);
  },
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Riftcoach | League of Legends Insights & Rewind',
      },
      {
        name: 'description',
        content:
          'Riftcoach helps League of Legends players analyze their performance, celebrate achievements, and unlock data-driven insights.',
      },
      {
        property: 'og:title',
        content: 'Riftcoach | League of Legends Insights & Rewind',
      },
      {
        property: 'og:description',
        content:
          'Track your League of Legends progress with personalized rewinds, performance analytics, and actionable coaching insights.',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="dark">
        <DataDragonProvider>{children}</DataDragonProvider>
        {process.env.NODE_ENV === 'development' && (
          <TanstackDevtools
            config={{
              position: 'bottom-left',
            }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
              TanStackQueryDevtools,
            ]}
          />
        )}
        <Scripts />
      </body>
    </html>
  );
}
