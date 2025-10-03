import {
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  type QueryExecution,
  type Row,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';
import ms from 'ms';
import { athenaClient } from '../clients/athena.js';

const DEFAULT_POLL_INTERVAL_MS = ms('1s');
const DEFAULT_MAX_ATTEMPTS = 120; // up to two minutes by default

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
  let state: QueryExecution['Status']['State'] | undefined;
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

  return {
    queryExecutionId,
    records: rowsToRecords(allRows),
    statistics: execution?.Statistics,
  };
}
