#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./mcp/server.js";
import { optionsFromEnv, PenpotClient } from "./penpot/client.js";

async function main() {
  if (process.argv.includes("--help")) {
    process.stdout.write("penpot-headless-mcp\n\nRequired: PENPOT_URL, PENPOT_ACCESS_TOKEN\nOptional: PENPOT_READ_ONLY=true, PENPOT_TIMEOUT_MS=30000\nTransport: MCP over stdio. No browser or Penpot plugin is required.\n");
    return;
  }
  if (process.env.PENPOT_READ_ONLY && !["true", "false"].includes(process.env.PENPOT_READ_ONLY)) {
    throw new Error("PENPOT_READ_ONLY must be true or false.");
  }
  const server = createServer(new PenpotClient(optionsFromEnv()), process.env.PENPOT_READ_ONLY === "true");
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  // Startup errors contain configuration guidance only. Never print the environment.
  process.stderr.write(`penpot-headless-mcp: ${error instanceof Error ? error.message : "Startup failed."}\n`);
  process.exitCode = 1;
});
