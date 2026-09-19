import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RuntimeContext } from "../runtime/context.js";
import type { ToolDefinition } from "./tool-definition.js";
import { networkTool } from "../network/gateway.js";
import { assertAllowedInSmartScope } from "../runtime/smart-scope.js";

export function registerCatalogTool(server: McpServer, context: RuntimeContext, tool: ToolDefinition): void {
  server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema.shape,
      outputSchema: tool.outputSchema.shape,
      annotations: tool.annotations
    },
    async (args) => {
      // Checked on the call, not only when the catalogue was built: a client
      // holding an older tool list still reaches this handler. Checked before
      // the peer gateway too, so a restricted connection cannot reach past its
      // approved folders by naming a paired device's root instead.
      assertAllowedInSmartScope(tool.name);
      return networkTool(tool.name, args, () => tool.handler(args, context));
    }
  );
}
