#!/usr/bin/env node
import { config } from "dotenv";
import consola from "consola";
import chalk from "chalk";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Get current directory for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load environment variables from .env file BEFORE importing refresh module
config({
  path: join(__dirname, "..", ".env"),
  debug: true,
});

async function main() {
  const { handler } = await import("./refresh.js");
  try {
    consola.start(chalk.cyan("🚀 Starting pro-exporter as Node.js process"));

    // Run the handler
    const result = await handler();

    consola.success(chalk.green("✅ Pro-exporter completed successfully"));
    console.log("Result:", result);

    process.exit(0);
  } catch (error) {
    consola.error(chalk.red("❌ Pro-exporter failed:"), error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  consola.info(chalk.yellow("🛑 Received SIGINT, shutting down gracefully..."));
  process.exit(0);
});

process.on("SIGTERM", () => {
  consola.info(
    chalk.yellow("🛑 Received SIGTERM, shutting down gracefully...")
  );
  process.exit(0);
});

// Run the main function
main().catch((error) => {
  consola.error(chalk.red("❌ Unhandled error in main:"), error);
  process.exit(1);
});
