/**
 * Print the authoritative chain list as a table.
 *
 * Chain IDs in the docs are examples, not a contract — this is the only list
 * that matters, and it tells us which chains support private mempool routing
 * (which is where payouts should go).
 *
 *   npm run chains                # enabled chains only
 *   npm run chains -- --testnet   # enabled testnets
 *   npm run chains -- --all       # everything, including disabled
 */

import "dotenv/config";
import { KeeperHubClient, KeeperHubError } from "../src/keeperhub/client.js";

interface Chain {
  chainId: number;
  name: string;
  symbol: string;
  chainType: string;
  isTestnet: boolean;
  isEnabled: boolean;
  usePrivateMempoolRpc: boolean;
  explorerUrl: string;
}

const ALL = process.argv.includes("--all");
const TESTNET_ONLY = process.argv.includes("--testnet");
const MAINNET_ONLY = process.argv.includes("--mainnet");

async function main(): Promise<void> {
  const apiKey = process.env.KEEPERHUB_API_KEY;
  if (!apiKey) {
    console.error("KEEPERHUB_API_KEY is not set. See .env.example.");
    process.exit(1);
  }

  const client = new KeeperHubClient({ apiKey, baseUrl: process.env.KEEPERHUB_BASE_URL });
  const raw = await client.listChains();

  const chains = extractChains(raw);
  const filtered = chains.filter((c) => {
    if (!ALL && !c.isEnabled) return false;
    if (TESTNET_ONLY && !c.isTestnet) return false;
    if (MAINNET_ONLY && c.isTestnet) return false;
    return true;
  });

  filtered.sort(
    (a, b) =>
      a.chainType.localeCompare(b.chainType) ||
      Number(a.isTestnet) - Number(b.isTestnet) ||
      a.name.localeCompare(b.name),
  );

  const header = ["chainId", "name", "sym", "type", "net", "private", "on"];
  const rows = filtered.map((c) => [
    String(c.chainId),
    c.name,
    c.symbol,
    c.chainType,
    c.isTestnet ? "test" : "main",
    c.usePrivateMempoolRpc ? "yes" : "-",
    c.isEnabled ? "yes" : "-",
  ]);

  printTable(header, rows);

  console.log(
    `\n${filtered.length} of ${chains.length} chains shown. ` +
      `${chains.filter((c) => c.usePrivateMempoolRpc).length} support private mempool routing.`,
  );
}

/** The list may arrive bare or wrapped in { items } / { data }. */
function extractChains(raw: unknown): Chain[] {
  const candidate = Array.isArray(raw)
    ? raw
    : ((raw as Record<string, unknown>)?.items ?? (raw as Record<string, unknown>)?.data);

  if (!Array.isArray(candidate)) {
    throw new Error(`Unexpected chain list shape: ${JSON.stringify(raw).slice(0, 200)}`);
  }

  return candidate.map((entry) => {
    const c = entry as Record<string, unknown>;
    return {
      chainId: Number(c.chainId),
      name: String(c.name ?? "?"),
      symbol: String(c.symbol ?? "?"),
      chainType: String(c.chainType ?? "?"),
      isTestnet: Boolean(c.isTestnet),
      isEnabled: Boolean(c.isEnabled),
      usePrivateMempoolRpc: Boolean(c.usePrivateMempoolRpc),
      explorerUrl: String(c.explorerUrl ?? ""),
    };
  });
}

function printTable(header: string[], rows: string[][]): void {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ");

  console.log(line(header));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) console.log(line(row));
}

main().catch((error: unknown) => {
  if (error instanceof KeeperHubError) {
    console.error(`\n✗ ${error.message}\n  ${JSON.stringify(error.body)}`);
  } else {
    console.error(`\n✗ ${error instanceof Error ? error.stack : String(error)}`);
  }
  process.exit(1);
});
