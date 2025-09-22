import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  QueryExecutionState,
  type StartQueryExecutionCommandInput,
  type GetQueryResultsCommandOutput,
} from "@aws-sdk/client-athena";

export interface AthenaQueryOptions {
  database?: string;
  workgroup?: string;
  outputLocation?: string;
  maxRetries?: number;
  retryDelayMs?: number;
}

export interface AthenaQueryResult<T = any> {
  data: T[];
  executionId: string;
  statistics?: {
    executionTimeInMillis?: number;
    dataScannedInBytes?: number;
    resultReuseInformation?: any;
  };
}

export class AthenaQueryClient {
  private client: AthenaClient;
  private defaultOptions: Required<AthenaQueryOptions>;

  constructor(options: Partial<AthenaQueryOptions> = {}) {
    this.client = new AthenaClient({
      region: process.env.AWS_REGION || "eu-west-1",
    });

    this.defaultOptions = {
      database: options.database || process.env.ATHENA_DATABASE || "lol",
      workgroup: options.workgroup || process.env.ATHENA_WORKGROUP || "primary",
      outputLocation:
        options.outputLocation ||
        `s3://${process.env.S3_BUCKET}/athena-results/`,
      maxRetries: options.maxRetries || 3,
      retryDelayMs: options.retryDelayMs || 1000,
    };
  }

  /**
   * Execute a query and return typed results
   */
  async query<T = any>(
    sql: string,
    options: Partial<AthenaQueryOptions> = {}
  ): Promise<AthenaQueryResult<T>> {
    const mergedOptions = { ...this.defaultOptions, ...options };

    // Start query execution
    const executionId = await this.startQuery(sql, mergedOptions);

    // Wait for completion
    await this.waitForQueryCompletion(executionId, mergedOptions);

    // Get results
    const results = await this.getQueryResults(executionId);

    return {
      data: this.parseResults<T>(results),
      executionId,
    };
  }

  /**
   * Start query execution
   */
  private async startQuery(
    sql: string,
    options: Required<AthenaQueryOptions>
  ): Promise<string> {
    const params: StartQueryExecutionCommandInput = {
      QueryString: sql,
      QueryExecutionContext: {
        Database: options.database,
      },
      WorkGroup: options.workgroup,
      ResultConfiguration: {
        OutputLocation: options.outputLocation,
      },
    };

    const command = new StartQueryExecutionCommand(params);
    const response = await this.client.send(command);

    if (!response.QueryExecutionId) {
      throw new Error("Failed to start query execution");
    }

    return response.QueryExecutionId;
  }

  /**
   * Wait for query completion with retries
   */
  private async waitForQueryCompletion(
    executionId: string,
    options: Required<AthenaQueryOptions>
  ): Promise<void> {
    let retries = 0;

    while (retries < options.maxRetries) {
      const command = new GetQueryExecutionCommand({
        QueryExecutionId: executionId,
      });
      const response = await this.client.send(command);

      const state = response.QueryExecution?.Status?.State;

      if (state === QueryExecutionState.SUCCEEDED) {
        return;
      }

      if (
        state === QueryExecutionState.FAILED ||
        state === QueryExecutionState.CANCELLED
      ) {
        const reason = response.QueryExecution?.Status?.StateChangeReason;
        throw new Error(`Query failed: ${reason}`);
      }

      // Still running, wait and retry
      await this.sleep(options.retryDelayMs);
      retries++;
    }

    throw new Error(`Query timeout after ${options.maxRetries} retries`);
  }

  /**
   * Get query results
   */
  private async getQueryResults(
    executionId: string
  ): Promise<GetQueryResultsCommandOutput> {
    const command = new GetQueryResultsCommand({
      QueryExecutionId: executionId,
    });
    return await this.client.send(command);
  }

  /**
   * Parse Athena results into typed objects
   */
  private parseResults<T>(results: GetQueryResultsCommandOutput): T[] {
    const rows = results.ResultSet?.Rows || [];

    if (rows.length === 0) {
      return [];
    }

    // First row contains column names
    const headers = rows[0]?.Data?.map((col) => col.VarCharValue || "") || [];

    // Parse data rows
    return rows.slice(1).map((row) => {
      const obj: any = {};
      row.Data?.forEach((cell, index) => {
        const key = headers[index];
        const value = cell.VarCharValue;

        // Try to parse numbers
        if (value && !isNaN(Number(value))) {
          obj[key as string] = Number(value);
        } else {
          obj[key as string] = value || null;
        }
      });
      return obj as T;
    });
  }

  /**
   * Utility sleep function
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Build parameterized query with proper escaping
   */
  static buildQuery(template: string, params: Record<string, any>): string {
    return template.replace(/\$\{(\w+)\}/g, (match, key) => {
      const value = params[key];
      if (value === undefined) {
        throw new Error(`Missing parameter: ${key}`);
      }

      // Handle different types
      if (typeof value === "string") {
        return `'${value.replace(/'/g, "''")}'`; // Escape single quotes
      }
      if (Array.isArray(value)) {
        return value
          .map((v) =>
            typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : v
          )
          .join(", ");
      }
      return String(value);
    });
  }
}

// Export singleton instance
export const athenaClient = new AthenaQueryClient();
