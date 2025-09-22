/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "riftcoach",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: ["production"].includes(input?.stage),
      home: "aws",
      providers: {
        aws: {
          region: "eu-west-1", // Updated to match roadmap requirements
        },
      },
    };
  },
  async run() {
    // Reference existing S3 bucket from roadmap
    const bucket = new sst.aws.Bucket("riftcoach", {
      public: false,
    });

    // Create Athena API function with proper permissions
    const athenaApi = new sst.aws.Function("AthenaApi", {
      url: true,
      link: [bucket],
      handler: "apps/api/src/index.handler",
      runtime: "nodejs20.x",
      timeout: "30 seconds",
      memory: "512 MB",
      environment: {
        S3_BUCKET: bucket.name,
        ATHENA_DATABASE: "lol",
        ATHENA_WORKGROUP: "primary",
      },
      permissions: [
        {
          actions: [
            "athena:StartQueryExecution",
            "athena:GetQueryExecution",
            "athena:GetQueryResults",
            "athena:StopQueryExecution",
            "athena:GetWorkGroup",
            "glue:GetTable",
            "glue:GetPartitions",
            "glue:GetDatabase",
            "s3:GetObject",
            "s3:ListBucket",
            "s3:GetBucketLocation",
          ],
          resources: ["*"],
        },
      ],
    });

    return {
      api: athenaApi.url,
    };
  },
});
