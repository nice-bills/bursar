/**
 * @elizaos/plugin-sql@1.7.2 ships broken type declarations: its exports map
 * points at ./index.node.d.ts, which is not in the published package. Declared
 * here so the agent harness can use it under strict TypeScript.
 *
 * Only the surface we actually touch is declared.
 */
declare module "@elizaos/plugin-sql" {
  import type { Plugin } from "@elizaos/core";
  import type { IDatabaseAdapter, UUID } from "@elizaos/core";
  export const plugin: Plugin;
  export default plugin;

  export function createDatabaseAdapter(
    config: { dataDir?: string; postgresUrl?: string },
    agentId: UUID,
  ): IDatabaseAdapter & { getDatabase(): unknown; db?: unknown };

  export class DatabaseMigrationService {
    initializeWithDatabase(db: unknown): Promise<void>;
    discoverAndRegisterPluginSchemas(plugins: Plugin[]): void;
    runAllPluginMigrations(): Promise<void>;
  }
}

/** plugin-bootstrap ships no type declarations at all. */
declare module "@elizaos/plugin-bootstrap" {
  import type { Plugin } from "@elizaos/core";
  export const bootstrapPlugin: Plugin;
  export default bootstrapPlugin;
}

/** plugin-openrouter's types are not resolvable through its exports map. */
declare module "@elizaos/plugin-openrouter" {
  import type { Plugin } from "@elizaos/core";
  export const openrouterPlugin: Plugin;
  export default openrouterPlugin;
}
