import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  type QueryExecution,
  type Row,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import consola from 'consola';
import ms from 'ms';
import { v5 as uuidv5 } from 'uuid';
import { athenaClient } from '../clients/athena.js';
import { s3Client } from '../clients/s3.js';

const DEFAULT_POLL_INTERVAL_MS = ms('1s');
const DEFAULT_MAX_ATTEMPTS = 120; // up to two minutes by default
const UUID_NAMESPACE = '0199c4d2-eb9f-7b80-9696-9b93b8060829';

type AthenaRecord = Record<string, string | null>;

export interface AthenaQueryOptions {
  query: string;
  database?: string;
  workGroup?: string;
  outputLocation?: string;
  maxAttempts?: number;
  pollIntervalMs?: number;
}

export interface AthenaQueryResult {
  queryExecutionId: string;
  records: AthenaRecord[];
  statistics?: QueryExecution['Statistics'];
}

function wait(msValue: number) {
  return new Promise((resolve) => setTimeout(resolve, msValue));
}

function rowsToRecords(rows: Row[]): AthenaRecord[] {
  const records: AthenaRecord[] = [];
  let headers: string[] | null = null;

  for (const row of rows) {
    const cells = row.Data ?? [];

    if (!headers) {
      headers = cells.map((cell) => cell.VarCharValue ?? '');
      continue;
    }

    const record: AthenaRecord = {};
    headers.forEach((header, idx) => {
      record[header] = cells[idx]?.VarCharValue ?? null;
    });
    records.push(record);
  }

  return records;
}

export async function runAthenaQuery({
  query,
  database = process.env.ATHENA_DATABASE,
  workGroup = process.env.ATHENA_WORKGROUP,
  outputLocation = process.env.ATHENA_OUTPUT_LOCATION,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: AthenaQueryOptions): Promise<AthenaQueryResult> {
  const start = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      WorkGroup: workGroup,
      QueryExecutionContext: database ? { Database: database } : undefined,
      ResultConfiguration: {
        OutputLocation:
          outputLocation ??
          process.env.ATHENA_OUTPUT_LOCATION ??
          `s3://${process.env.S3_BUCKET}/athena-results/`,
      },
    }),
  );

  const queryExecutionId = start.QueryExecutionId;
  if (!queryExecutionId) {
    throw new Error('Failed to start Athena query execution');
  }

  let attempts = 0;
  let state: string | undefined;
  let execution: QueryExecution | undefined;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const executionResponse = await athenaClient.send(
      new GetQueryExecutionCommand({ QueryExecutionId: queryExecutionId }),
    );
    execution = executionResponse.QueryExecution;
    state = execution?.Status?.State;

    if (state === 'SUCCEEDED') {
      break;
    }

    if (state === 'FAILED' || state === 'CANCELLED') {
      const reason = execution?.Status?.StateChangeReason ?? 'unknown reason';
      throw new Error(`Athena query ${state?.toLowerCase()} (${reason})`);
    }

    attempts += 1;
    if (attempts >= maxAttempts) {
      throw new Error('Athena query polling exceeded max attempts');
    }

    await wait(pollIntervalMs);
  }

  // Check if this is a DML operation that doesn't return meaningful results
  const isDMLOperation =
    /^\s*(MERGE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\s+/i.test(query.trim());

  let records: AthenaRecord[] = [];

  if (!isDMLOperation) {
    // Only fetch results for SELECT queries
    const allRows: Row[] = [];
    let nextToken: string | undefined;

    do {
      const results = await athenaClient.send(
        new GetQueryResultsCommand({
          QueryExecutionId: queryExecutionId,
          NextToken: nextToken,
        }),
      );

      allRows.push(...(results.ResultSet?.Rows ?? []));
      nextToken = results.NextToken;
    } while (nextToken);

    records = rowsToRecords(allRows);
  }

  return {
    queryExecutionId,
    records,
    statistics: execution?.Statistics,
  };
}

export async function runAthenaQueryWithCache({
  query,
  database,
  workGroup,
  outputLocation,
  maxAttempts,
  pollIntervalMs,
}: AthenaQueryOptions): Promise<AthenaQueryResult> {
  const internalId = Buffer.from(query, 'utf8').toString('base64');
  const cacheKey = uuidv5(internalId, UUID_NAMESPACE);

  const cachedResult = await s3Client
    .send(
      new GetObjectCommand({
        Bucket: process.env.S3_BUCKET,
        Key: `athena-results/${cacheKey}.json`,
        ResponseContentEncoding: 'utf-8',
        ResponseContentType: 'application/json',
      }),
    )
    .catch(() => null);

  if (cachedResult?.Body) {
    const res = await cachedResult.Body.transformToString();
    return JSON.parse(res);
  }

  const result = await runAthenaQuery({
    query,
    database,
    workGroup,
    outputLocation,
    maxAttempts,
    pollIntervalMs,
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: `athena-results/${cacheKey}.json`,
      Body: JSON.stringify(result),
      ContentType: 'application/json',
      Expires: new Date(Date.now() + ms('1h')),
    }),
  );

  return result;
}
