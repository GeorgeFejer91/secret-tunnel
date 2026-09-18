import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import packageInfo from "../package.json" with { type: "json" };
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { toolRegistry } from "./tools/registry.js";
import { registerCatalogTool } from "./tools/define-tool.js";
import { registerGitHubTools } from "./github-bridge.js";
import { registerDirectGitHubTools } from "./github-direct.js";
import type { RuntimeContext } from "./runtime/context.js";

export { SERVER_INSTRUCTIONS };

const READ_ONLY_SURFACE_ENV = "GPT_REPO_READ_ONLY_SURFACE";

export function createMcpServer(context: RuntimeContext): McpServer {
  const server = new McpServer(
    {
      name: "gpt-repo-mcp",
      version: packageInfo.version
    },
    {
      capabilities: {
        tools: {}
      },
      instructions: SERVER_INSTRUCTIONS
    }
  );

  const readOnlySurface = process.env[READ_ONLY_SURFACE_ENV] === "1";
  const tools = readOnlySurface
    ? toolRegistry.filter((tool) => tool.annotations.readOnlyHint === true)
    : toolRegistry;

  // GitHub goes first, ahead of the ~46 repository tools.
  //
  // tools/list preserves registration order, and clients that cap how many
  // tools they import from one connector keep the head of that list. Last
  // place meant every GitHub tool sat at index 46-62 and a capped client saw
  // none of them, which is the publishing surface the product exists for.
  // Ordering is presentation only: nothing here changes what a tool does.

  // These do not touch the repository themselves. They ask the Secret Tunnel
  // desktop app to, and are registered only when that app has started its
  // loopback broker.
  registerGitHubTools(server, readOnlySurface);

  // The second GitHub path. These call api.github.com from this process using
  // the same one-time authorization, so the two approaches can be compared on
  // real work. Neither path ever stands in for the other.
  registerDirectGitHubTools(server, context, readOnlySurface);

  for (const tool of tools) {
    registerCatalogTool(server, context, tool);
  }

  return server;
}
