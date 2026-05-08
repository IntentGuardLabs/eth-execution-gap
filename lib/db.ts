/**
 * Local file-based cache for the CLI.
 *
 * Replaces the Prisma-backed cache used by the web-app branch with plain
 * JSON files under `.cache/`. Exported function signatures match the
 * web-app version so callers in `lib/data-sources/*` and `lib/analysis/*`
 * don't need to change. There are NO result tables here — runs compute
 * in memory and the CLI prints / writes a report file. Nothing is
 * persisted beyond the upstream-API caches below.
 *
 * Cache layout:
 *   .cache/tenderly/{txHash}_{blockNumber}.json
 *   .cache/dune/mempool/{txHash}.json
 *   .cache/dune/protocol/{router}.json                  (rows)
 *   .cache/dune/protocol/{router}.fetched-at.json       (TTL marker)
 *   .cache/prices/{tokenAddress}.json
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  MempoolData,
  ProtocolTxRow,
  SimulationResult,
} from "@/lib/types";

const CACHE_ROOT = process.env.CLI_CACHE_DIR ?? ".cache";

// ─── primitive helpers ─────────────────────────────────────────────────────

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const buf = await readFile(path, "utf8");
    return JSON.parse(buf) as T;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    const st = await stat(path);
    return st.mtimeMs;
  } catch {
    return null;
  }
}

function safe(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

// ─── Tenderly simulation cache ─────────────────────────────────────────────

function tenderlyPath(
  txHash: string,
  blockNumber: number,
  transactionIndex: number
): string {
  return join(
    CACHE_ROOT,
    "tenderly",
    `${safe(txHash)}_${blockNumber}_i${transactionIndex}.json`
  );
}

interface TenderlyEntry {
  txHash: string;
  blockNumber: number;
  transactionIndex: number;
  from: string;
  to: string;
  input: string;
  value: string;
  gas: string;
  gasPrice: string;
  simulationResult: SimulationResult;
  simulatedAt: string;
}

export async function storeTenderlySimulation(
  txHash: string,
  blockNumber: number,
  transactionIndex: number,
  simulationData: {
    from: string;
    to: string;
    input: string;
    value: string;
    gas: string;
    gasPrice: string;
    simulationResult: Record<string, any>;
  }
): Promise<void> {
  const entry: TenderlyEntry = {
    txHash,
    blockNumber,
    transactionIndex,
    from: simulationData.from,
    to: simulationData.to,
    input: simulationData.input,
    value: simulationData.value,
    gas: simulationData.gas,
    gasPrice: simulationData.gasPrice,
    simulationResult: simulationData.simulationResult as SimulationResult,
    simulatedAt: new Date().toISOString(),
  };
  await writeJson(tenderlyPath(txHash, blockNumber, transactionIndex), entry);
}

export async function getCachedSimulation(
  txHash: string,
  blockNumber: number,
  transactionIndex: number
): Promise<SimulationResult | null> {
  const entry = await readJson<TenderlyEntry>(
    tenderlyPath(txHash, blockNumber, transactionIndex)
  );
  if (!entry?.simulationResult) return null;
  // Defensive: pre-2026-05-08 cache entries don't carry the `status`
  // field. Without it, the analyzer can't distinguish "sim succeeded
  // with no flows" from "sim reverted" — and that distinction is what
  // separates a real gap from trade-notional noise. Treat as cache
  // miss so the next run rebuilds with the full shape.
  if (typeof entry.simulationResult.status !== "boolean") {
    console.log(
      `[cache] tenderly entry missing status field (legacy shape) — refetching ${txHash}@${blockNumber}#${transactionIndex}`
    );
    return null;
  }
  return entry.simulationResult;
}

// ─── Dune mempool cache (per-tx) ───────────────────────────────────────────

function duneMempoolPath(txHash: string): string {
  return join(CACHE_ROOT, "dune", "mempool", `${safe(txHash)}.json`);
}

interface DuneMempoolEntry {
  txHash: string;
  data: MempoolData;
  fetchedAt: string;
}

export async function storeDuneMempoolData(
  txHash: string,
  data: MempoolData
): Promise<void> {
  const entry: DuneMempoolEntry = {
    txHash,
    data,
    fetchedAt: new Date().toISOString(),
  };
  await writeJson(duneMempoolPath(txHash), entry);
}

export async function getCachedMempoolData(
  txHashes: string[]
): Promise<Map<string, MempoolData>> {
  const out = new Map<string, MempoolData>();
  for (const h of txHashes) {
    const entry = await readJson<DuneMempoolEntry>(duneMempoolPath(h));
    if (entry) out.set(h.toLowerCase(), entry.data);
  }
  return out;
}

// ─── Token price cache (DeFiLlama) ─────────────────────────────────────────

function pricePath(tokenAddress: string): string {
  return join(CACHE_ROOT, "prices", `${safe(tokenAddress)}.json`);
}

interface PriceEntry {
  tokenAddress: string;
  priceUsd: number;
  fetchedAt: string;
}

export async function storePrices(prices: Map<string, number>): Promise<void> {
  for (const [token, priceUsd] of prices) {
    const entry: PriceEntry = {
      tokenAddress: token.toLowerCase(),
      priceUsd,
      fetchedAt: new Date().toISOString(),
    };
    await writeJson(pricePath(token), entry);
  }
}

const PRICE_TTL_MS = 60 * 60 * 1000; // 1h — prices age, but the CLI run is short

export async function getCachedPrices(
  tokenAddresses: string[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const now = Date.now();
  for (const t of tokenAddresses) {
    const path = pricePath(t);
    const mtime = await fileMtimeMs(path);
    if (mtime == null || now - mtime > PRICE_TTL_MS) continue;
    const entry = await readJson<PriceEntry>(path);
    if (entry) out.set(t.toLowerCase(), entry.priceUsd);
  }
  return out;
}

// ─── Dune protocol-tx cache (router-scoped) ────────────────────────────────

function protocolRowsPath(routerAddress: string): string {
  return join(CACHE_ROOT, "dune", "protocol", `${safe(routerAddress)}.json`);
}
function protocolMarkerPath(routerAddress: string): string {
  return join(
    CACHE_ROOT,
    "dune",
    "protocol",
    `${safe(routerAddress)}.fetched-at.json`
  );
}

interface ProtocolRowsEntry {
  routerAddress: string;
  windowDays: number;
  rows: ProtocolTxRow[];
  fetchedAt: string;
}

interface ProtocolMarkerEntry {
  routerAddress: string;
  windowDays: number;
  rowCount: number;
  fetchedAt: string;
}

export async function getCachedDuneProtocolTxs(
  routerAddress: string,
  windowDays: number,
  ttlMs: number
): Promise<ProtocolTxRow[] | null> {
  const marker = await readJson<ProtocolMarkerEntry>(
    protocolMarkerPath(routerAddress)
  );
  if (!marker) return null;
  const age = Date.now() - new Date(marker.fetchedAt).getTime();
  if (age > ttlMs) return null;
  if (marker.windowDays < windowDays) return null;

  const entry = await readJson<ProtocolRowsEntry>(
    protocolRowsPath(routerAddress)
  );
  if (!entry) return null;

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const rows = entry.rows.filter(
    (r) => new Date(r.inclusionBlockTime) >= cutoff
  );

  console.log(
    `[cache] Dune protocol HIT: router=${routerAddress.slice(0, 10)}... rows=${rows.length} (age=${(age / 1000).toFixed(0)}s)`
  );
  return rows;
}

export async function saveDuneProtocolTxsBatch(
  routerAddress: string,
  rows: ProtocolTxRow[]
): Promise<void> {
  if (rows.length === 0) return;
  const path = protocolRowsPath(routerAddress);
  const existing = await readJson<ProtocolRowsEntry>(path);
  const merged = mergeByTxHash(existing?.rows ?? [], rows);
  const entry: ProtocolRowsEntry = {
    routerAddress: routerAddress.toLowerCase(),
    windowDays: existing?.windowDays ?? 0,
    rows: merged,
    fetchedAt: new Date().toISOString(),
  };
  await writeJson(path, entry);
  console.log(
    `[cache] Dune protocol: appended ${rows.length} row(s); total=${merged.length}`
  );
}

export async function markDuneProtocolFetchComplete(
  routerAddress: string,
  windowDays: number,
  rowCount: number
): Promise<void> {
  const entry: ProtocolMarkerEntry = {
    routerAddress: routerAddress.toLowerCase(),
    windowDays,
    rowCount,
    fetchedAt: new Date().toISOString(),
  };
  await writeJson(protocolMarkerPath(routerAddress), entry);
  const rowsPath = protocolRowsPath(routerAddress);
  const existing = await readJson<ProtocolRowsEntry>(rowsPath);
  if (existing) {
    existing.windowDays = Math.max(existing.windowDays, windowDays);
    existing.fetchedAt = entry.fetchedAt;
    await writeJson(rowsPath, existing);
  }
  console.log(
    `[cache] Dune protocol marker: router=${routerAddress.slice(0, 10)}... rows=${rowCount} window=${windowDays}d`
  );
}

function mergeByTxHash(
  existing: ProtocolTxRow[],
  incoming: ProtocolTxRow[]
): ProtocolTxRow[] {
  const map = new Map<string, ProtocolTxRow>();
  for (const r of existing) map.set(r.txHash, r);
  for (const r of incoming) map.set(r.txHash, r);
  return Array.from(map.values()).sort(
    (a, b) =>
      new Date(b.inclusionBlockTime).getTime() -
      new Date(a.inclusionBlockTime).getTime()
  );
}
