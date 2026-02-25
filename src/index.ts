#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const apiKey = process.env.EXTEND_API_KEY;
if (!apiKey) {
  console.error(
    "EXTEND_API_KEY environment variable is required.\n" +
      "Get your API key at https://app.extend.ai/settings/api-keys",
  );
  process.exit(1);
}

const server = createServer({
  apiKey,
  environment: process.env.EXTEND_ENVIRONMENT,
  baseUrl: process.env.EXTEND_BASE_URL,
  tools: process.env.EXTEND_TOOLS,
  disableFilePath: !!process.env.EXTEND_DISABLE_FILE_PATH,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `Extend MCP server running on stdio (tools: ${process.env.EXTEND_TOOLS || "all"})`,
  );
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
