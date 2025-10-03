import { AthenaClient } from '@aws-sdk/client-athena';

const athenaClient = new AthenaClient({
  region: process.env.AWS_REGION ?? 'eu-west-1',
});

export { athenaClient };
