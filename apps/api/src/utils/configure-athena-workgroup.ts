import { CreateWorkGroupCommand, UpdateWorkGroupCommand } from '@aws-sdk/client-athena';
import { athenaClient } from '../clients/athena.js';

export interface WorkgroupConfig {
  name: string;
  description?: string;
  bytesScannedCutoffPerQuery?: number; // e.g., 2GB = 2 * 1024 * 1024 * 1024
  enforceWorkGroupConfiguration?: boolean;
  publishCloudWatchMetrics?: boolean;
  resultConfigurationOutputLocation?: string;
}

export async function configureAthenaWorkgroup(config: WorkgroupConfig) {
  const workgroupConfiguration = {
    ResultConfigurationUpdates: config.resultConfigurationOutputLocation ? {
      OutputLocation: config.resultConfigurationOutputLocation,
    } : undefined,
    BytesScannedCutoffPerQuery: config.bytesScannedCutoffPerQuery,
    EnforceWorkGroupConfiguration: config.enforceWorkGroupConfiguration ?? true,
    PublishCloudWatchMetricsEnabled: config.publishCloudWatchMetrics ?? true,
  };

  try {
    // Try to update existing workgroup first
    await athenaClient.send(
      new UpdateWorkGroupCommand({
        WorkGroup: config.name,
        Description: config.description,
        ConfigurationUpdates: workgroupConfiguration,
      }),
    );
    console.log(`✅ Updated workgroup: ${config.name}`);
  } catch (error) {
    // If workgroup doesn't exist, create it
    if (error instanceof Error && error.name === 'InvalidRequestException') {
      await athenaClient.send(
        new CreateWorkGroupCommand({
          Name: config.name,
          Description: config.description ?? `Workgroup for ${config.name}`,
          Configuration: {
            ResultConfiguration: config.resultConfigurationOutputLocation ? {
              OutputLocation: config.resultConfigurationOutputLocation,
            } : undefined,
            BytesScannedCutoffPerQuery: config.bytesScannedCutoffPerQuery,
            EnforceWorkGroupConfiguration: config.enforceWorkGroupConfiguration ?? true,
            PublishCloudWatchMetricsEnabled: config.publishCloudWatchMetrics ?? true,
          },
        }),
      );
      console.log(`✅ Created workgroup: ${config.name}`);
    } else {
      throw error;
    }
  }
}

// Example usage for your project
export async function setupRiftcoachWorkgroup() {
  await configureAthenaWorkgroup({
    name: process.env.ATHENA_WORKGROUP || 'riftcoach-workgroup',
    description: 'Riftcoach workgroup with resource limits',
    bytesScannedCutoffPerQuery: 5 * 1024 * 1024 * 1024, // 5GB limit
    enforceWorkGroupConfiguration: true,
    publishCloudWatchMetrics: true,
    resultConfigurationOutputLocation: process.env.ATHENA_OUTPUT_LOCATION,
  });
}