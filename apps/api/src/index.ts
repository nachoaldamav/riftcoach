import {
  PlatformId,
  type RiotAPITypes,
  regionToCluster,
} from '@fightmegg/riot-api';
import { serve } from '@hono/node-server';
import { createNodeWebSocket } from '@hono/node-ws';
import { client } from '@riftcoach/clients.mongodb';
import { setupWorkers } from '@riftcoach/queues';
import chalk from 'chalk';
import { consola } from 'consola';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import z from 'zod';
import { redis } from './clients/redis.js';
import { type Platform, type Region, riot } from './clients/riot-api.js';
import { riotAPI } from './clients/riot.js';
import { s3Client } from './clients/s3.js';
import { getCohortStatsPerRole } from './queries/cohorts-role-stats.js';
import { getPlayerStatsPerRole } from './queries/puuid-role-stats.js';
import {
  PROG,
  generateJobUUID,
  getJobMapping,
  rewindQ,
  storeJobMapping,
} from './queues/rewind.js';
import { fetchQ, listQ } from './queues/scan.js';
import { app as v1Route } from './routes/v1/index.js';
import { getCachedAIBadges } from './services/ai-service.js';
import { getQueuePosition } from './utils/queue-position.js';
import { runAthenaQueryWithCache } from './utils/run-athena-query.js';

const JOB_SCOPE = process.env.JOB_SCOPE ?? 'Y2025';

const app = new Hono();

app.use(
  '*',
  cors({
    origin: '*',
  }),
);

const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

// WebSocket connection management with subscriptions
const wsConnections = new Map<unknown, Set<string>>();

// Broadcast function for sending messages to subscribed clients only
export const broadcastToWebSockets = (channel: string, message: unknown) => {
  const messageStr = JSON.stringify(message);
  for (const [ws, subscriptions] of wsConnections) {
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    if ((ws as any).readyState === 1 && subscriptions.has(channel)) {
      // WebSocket.OPEN
      // biome-ignore lint/suspicious/noExplicitAny: <explanation>
      (ws as any).send(messageStr);
    }
  }
};

app.get(
  '/ws',
  upgradeWebSocket((c) => {
    return {
      onOpen(event, ws) {
        wsConnections.set(ws, new Set<string>());
        console.log(
          'WebSocket connection opened, total connections:',
          wsConnections.size,
        );
      },
      onMessage(event, ws) {
        try {
          const data = JSON.parse(event.data.toString());

          if (data.type === 'subscribe' && data.channel) {
            const subscriptions = wsConnections.get(ws);
            if (subscriptions) {
              subscriptions.add(data.channel);
              console.log(`Client subscribed to channel: ${data.channel}`);
              ws.send(
                JSON.stringify({
                  type: 'subscription_confirmed',
                  channel: data.channel,
                }),
              );
            }
          } else if (data.type === 'unsubscribe' && data.channel) {
            const subscriptions = wsConnections.get(ws);
            if (subscriptions) {
              subscriptions.delete(data.channel);
              console.log(`Client unsubscribed from channel: ${data.channel}`);
              ws.send(
                JSON.stringify({
                  type: 'unsubscription_confirmed',
                  channel: data.channel,
                }),
              );
            }
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      },
      onClose: (event, ws) => {
        wsConnections.delete(ws);
        console.log(
          'WebSocket connection closed, remaining connections:',
          wsConnections.size,
        );
      },
    };
  }),
);

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

/**
 * Health check endpoint
 * Showcase the health of the server and the clients
 */
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    redis: redis.status,
    riotAPI: riotAPI.token ? 'ready' : 'failed',
    s3: s3Client.config ? 'ready' : 'failed',
  });
});

app.route('/v1', v1Route);

const server = serve(
  {
    fetch: app.fetch,
    port: Number(process.env.PORT) || 4000,
  },
  async (info) => {
    setupWorkers();
    setupWorkers();
    await client.connect();
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);

injectWebSocket(server);
