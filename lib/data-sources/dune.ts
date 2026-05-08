import axios from "axios";
import { retryWithBackoff, sleep } from "@/lib/utils";
import {
  API_RATE_LIMITS,
  PROTOCOL_DUNE_CACHE_TTL_MS,
  PROTOCOL_PERSIST_BATCH,
} from "@/lib/constants";
import {
  getCachedDuneProtocolTxs,
  saveDuneProtocolTxsBatch,
  markDuneProtocolFetchComplete,
  getCachedMempoolData,
  storeDuneMempoolData,
} from "@/lib/db";
import type { MempoolData, ProtocolTxRow } from "@/lib/types";

const DUNE_API_URL = "https://api.dune.com/api/v1";

/**
 * Query Dune Analytics for mempool data
 */
export interface MempoolQueryOptions {
  /**
   * Narrow the dumpster scan to txs included within `[toBlock - searchBlocks, toBlock]`.
   * Without a block bound the SQL has to scan every partition of
   * `dune.flashbots.dataset_mempool_dumpster` (billions of rows) looking
   * for the hash, which routinely causes 100s+ cold-cache latency. With
   * a 10-block window, the dumpster's block-time partition pruning kicks
   * in and cold lookups complete in ~5–10s.
   *
   * If you don't know the inclusion block, omit this — correctness is
   * unaffected, only latency.
   */
  toBlock?: number;
  /** Default: 10. Increase if you've seen mempool→inclusion delays > 10 blocks (~120s). */
  searchBlocks?: number;
}

export async function queryMempoolData(
  txHashes: string[],
  opts: MempoolQueryOptions = {}
): Promise<Map<string, MempoolData>> {
  const apiKey = process.env.DUNE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "DUNE_API_KEY not configured. Please set it in environment variables."
    );
  }

  if (txHashes.length === 0) {
    return new Map();
  }

  // Per-tx cache check — mempool dumpster entries are immutable once a
  // tx is included, so a hit is always usable. Skip Dune entirely when
  // every requested hash is already cached.
  const lower = txHashes.map((h) => h.toLowerCase());
  const cached = await getCachedMempoolData(lower);
  if (cached.size === lower.length) {
    console.log(
      `[dune] mempool cache HIT for all ${lower.length} tx${lower.length === 1 ? "" : "es"} — skipping Dune query`
    );
    return cached;
  }
  const missing = lower.filter((h) => !cached.has(h));
  if (cached.size > 0) {
    console.log(
      `[dune] mempool cache HIT for ${cached.size}/${lower.length}; querying Dune for the remaining ${missing.length}`
    );
  }

  const results = new Map(cached);

  try {
    // Format tx hashes for SQL query — only the ones we don't already have.
    const hashList = missing.map((h) => `'${h}'`).join(",");

    // Resolve the mempool block via pure arithmetic (post-merge slots are
    // a fixed 12s) instead of joining `ethereum.blocks` on a 13s window —
    // the join is fragile, has produced duplicate rows in the past
    // (EC-P1.4), and adds a costly table scan. This is the same
    // arithmetic the protocol query uses.
    //
    // Schema: the table is `dune.flashbots.dataset_mempool_dumpster`
    // (NOT `flashbots.dataset_mempool_dumpster`) and DuneSQL v2 returns
    // `inclusion_delay_ms` / `timestamp_ms` as varchar despite the docs
    // — must CAST before arithmetic.
    //
    // Block-range filter: when the caller passes `toBlock`, we add
    // `included_at_block_height BETWEEN (toBlock - searchBlocks) AND toBlock`
    // so the dumpster's partition pruning takes effect. Without it, a
    // single-hash lookup can scan billions of rows.
    const searchBlocks = opts.searchBlocks ?? 10;
    const blockFilter =
      opts.toBlock != null
        ? `AND CAST(mp.included_at_block_height AS bigint)
             BETWEEN ${opts.toBlock - searchBlocks} AND ${opts.toBlock}`
        : "";
    const sql = `
      SELECT
        mp.hash,
        CAST(mp.timestamp_ms AS bigint)             AS timestamp_ms,
        CAST(mp.inclusion_delay_ms AS bigint)       AS inclusion_delay_ms,
        CAST(mp.included_at_block_height AS bigint) AS included_at_block_height,
        CAST(mp.included_at_block_height AS bigint)
          - CAST(ceil(CAST(mp.inclusion_delay_ms AS double) / 12000.0) AS integer)
          AS mempool_block_number
      FROM dune.flashbots.dataset_mempool_dumpster mp
      WHERE mp.hash IN (${hashList})
        ${blockFilter}
    `;

    // Execute ad-hoc SQL query via Dune v1 API
    console.log(`[dune] Executing SQL query for ${txHashes.length} tx hashes`);
    const executionId = await retryWithBackoff(
      async () => {
        const response = await axios.post(
          `${DUNE_API_URL}/sql/execute`,
          {
            sql,
            performance: "medium",
          },
          {
            headers: {
              "X-Dune-Api-Key": apiKey,
              "Content-Type": "application/json",
            },
            timeout: API_RATE_LIMITS.DUNE_QUERY_TIMEOUT_MS,
          }
        );

        console.log(`[dune] Query submitted, execution_id: ${response.data.execution_id}`);
        return response.data.execution_id;
      },
      2,
      2000
    );

    // Poll for results using the results endpoint (includes status).
    // 240s ceiling matches the protocol query — Dune wait times vary
    // wildly even for trivial single-row lookups.
    let isComplete = false;
    let attempts = 0;
    const maxAttempts = 120; // 120 * 2s = 240 seconds timeout

    while (!isComplete && attempts < maxAttempts) {
      await sleep(2000);
      attempts++;

      const resultsResponse = await axios.get(
        `${DUNE_API_URL}/execution/${executionId}/results`,
        {
          headers: {
            "X-Dune-Api-Key": apiKey,
          },
          timeout: API_RATE_LIMITS.DUNE_QUERY_TIMEOUT_MS,
        }
      );

      const state = resultsResponse.data.state;
      console.log(`[dune] Poll #${attempts}: state=${state}`);

      if (state === "QUERY_STATE_COMPLETED" || state === "QUERY_STATE_COMPLETED_PARTIAL") {
        isComplete = true;

        if (state === "QUERY_STATE_COMPLETED_PARTIAL") {
          console.warn(`[dune] Query returned partial results — some rows may be missing`);
        }

        // Process results - group by tx hash and take the most recent block
        const groupedByHash = new Map<string, any[]>();

        for (const row of resultsResponse.data.result?.rows || []) {
          const hash = row.hash.toLowerCase();
          if (!groupedByHash.has(hash)) {
            groupedByHash.set(hash, []);
          }
          groupedByHash.get(hash)!.push(row);
        }

        // For each hash, take the first result (most recent block due to ORDER BY DESC)
        // and persist to the per-tx file cache so subsequent CLI runs skip Dune.
        for (const [hash, rows] of groupedByHash.entries()) {
          if (rows.length > 0) {
            const row = rows[0];
            const data: MempoolData = {
              hash: row.hash,
              timestamp_ms: row.timestamp_ms,
              inclusion_delay_ms: row.inclusion_delay_ms,
              included_at_block_height: row.included_at_block_height,
              mempool_block_number:
                row.mempool_block_number ?? row.included_at_block_height - 1,
            };
            results.set(hash, data);
            try {
              await storeDuneMempoolData(hash, data);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              console.warn(`[dune] failed to cache mempool data for ${hash}: ${msg}`);
            }
          }
        }

        console.log(
          `[dune] Query complete, got mempool data for ${results.size - cached.size} new txs (total ${results.size})`
        );
      } else if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELED" || state === "QUERY_STATE_EXPIRED") {
        // Dune returns `error` as an object, not a string (EC-3.3) — extract
        // the human-readable message rather than letting `[object Object]`
        // through to the caller.
        const errObj = resultsResponse.data.error;
        const errMsg =
          typeof errObj === "string"
            ? errObj
            : errObj?.message
              ? errObj.message
              : JSON.stringify(errObj ?? "unknown error");
        throw new Error(`Dune query ${state}: ${errMsg}`);
      }
    }

    if (!isComplete) {
      throw new Error("Dune query timeout after 120 seconds");
    }
  } catch (error) {
    console.error("[dune] Error querying Dune Analytics:", error instanceof Error ? error.message : error);
    throw error;
  }

  return results;
}

/**
 * Fallback: estimate mempool block number from inclusion block.
 */
export function estimateMempoolBlockNumber(includedAtBlockHeight: number): number {
  // Conservative estimate: mempool block is one block before inclusion
  return Math.max(0, includedAtBlockHeight - 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Module P1: Protocol-level tx source
// Joins ethereum.transactions (filtered by `to = routerAddress`) with
// flashbots.dataset_mempool_dumpster and ethereum.blocks in a single query.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProtocolTxQueryInput {
  routerAddress: string;   // lowercase
  windowDays: number;
  /**
   * Precise sub-day window in minutes. When set (> 0), takes precedence
   * over `windowDays` in the SQL `block_time` filter. Cache is bypassed.
   */
  windowMinutes?: number;
  limit: number;
}

/**
 * Query Dune for all transactions sent to a protocol router within a window,
 * enriched with mempool first-seen timestamps from flashbots.dataset_mempool_dumpster.
 *
 * Returns one row per router tx. `mempoolTimestampMs` / `mempoolBlockNumber` /
 * `inclusionDelayMs` are null when the tx is not in the mempool dumpster
 * (e.g. private relay / Flashbots bundles).
 */
export async function queryProtocolTxsWithMempool(
  input: ProtocolTxQueryInput
): Promise<ProtocolTxRow[]> {
  const router = input.routerAddress.toLowerCase();
  const days = Math.max(1, Math.floor(input.windowDays));
  const limit = Math.max(1, Math.floor(input.limit));
  const useMinutes =
    input.windowMinutes !== undefined && input.windowMinutes > 0;
  const minutes = useMinutes
    ? Math.max(1, Math.floor(input.windowMinutes!))
    : 0;

  // Cache check first — a completed DuneProtocolFetch marker within TTL
  // whose windowDays >= requested lets us skip the Dune round-trip entirely.
  // See blueprint 02 Module P1 cache semantics.
  //
  // Sub-day windows (windowMinutes set) bypass the cache entirely: smoke
  // runs are ephemeral and caching a 10-min slice under a shared
  // router-scoped key would either pollute the cache or confuse its
  // windowDays-based hit rule. We also skip the marker write at the end.
  if (!useMinutes) {
    const cached = await getCachedDuneProtocolTxs(
      router,
      days,
      PROTOCOL_DUNE_CACHE_TTL_MS
    );
    if (cached) {
      return cached.slice(0, limit);
    }
  }

  const apiKey = process.env.DUNE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "DUNE_API_KEY not configured. Please set it in environment variables."
    );
  }

  // Query notes (validated against Dune docs for ethereum.transactions +
  // dune.flashbots.dataset_mempool_dumpster):
  //
  // - `0x...` is a valid VARBINARY literal in DuneSQL (Trino).
  // - `from`/`to` are quoted because Trino treats them as reserved words.
  // - `dune.flashbots.dataset_mempool_dumpster.hash` is **varchar** (lowercase
  //   `0x...`), while `ethereum.transactions.hash` is **varbinary**. The join
  //   coerces tx.hash → lowercase `0x`-prefixed varchar so both sides match.
  // - Mempool block number is derived in pure arithmetic:
  //     tx.block_number - ceil(inclusion_delay_ms / 12000)
  //   Post-merge blocks are fixed 12s slots, so this is accurate to ±1 block.
  //   Avoids a join against `ethereum.blocks` (no duplicate-row risk — that
  //   was EC-P1.4 — and one fewer table scan per query).
  // - EC-P1.5: `AND tx.success = true` skips reverted txs so we don't waste
  //   two Tenderly sims each on them.
  // - **Partition pruning** (EC-P1.8): `tx.block_date` is the partition key
  //   on `ethereum.transactions`. Filtering on `block_date` restricts the
  //   scan to 1–2 daily partitions instead of a full table scan. Without
  //   this filter a 1-day `block_time` predicate still triggers a full scan
  //   and runs out the Dune execution budget (observed: 240s+ timeout).
  //   The `block_date` predicate is slightly looser than `block_time` so
  //   we keep the `block_time` filter too — prune first, filter second.
  // - **Sub-day windows** (EC-P1.9): when `windowMinutes` is set, the
  //   `block_time` filter uses `INTERVAL 'N' MINUTE` instead of DAY. The
  //   `block_date` partition filter is widened to `INTERVAL '1' DAY` so it
  //   covers the midnight-crossing edge case (a 10-minute window that spans
  //   23:55 → 00:05 would miss today's first txs under a 0-day filter).
  const preciseFilter = useMinutes
    ? `CURRENT_TIMESTAMP - INTERVAL '${minutes}' MINUTE`
    : `CURRENT_TIMESTAMP - INTERVAL '${days}' DAY`;
  const partitionDays = useMinutes ? 1 : days;
  const sql = `
    SELECT
      tx.hash                 AS tx_hash,
      tx."from"               AS sender,
      tx."to"                 AS router,
      tx.data                 AS calldata,
      tx.value                AS value,
      tx.gas_price            AS gas_price,
      tx.block_number         AS inclusion_block_number,
      tx.block_time           AS inclusion_block_time,
      mp.timestamp_ms         AS mempool_timestamp_ms,
      mp.inclusion_delay_ms   AS inclusion_delay_ms,
      CASE
        WHEN mp.inclusion_delay_ms IS NULL THEN NULL
        -- dumpster columns advertised as Integer/BigInt in the docs come back
        -- as varchar in DuneSQL v2 — must cast before any arithmetic.
        ELSE tx.block_number - CAST(ceil(CAST(mp.inclusion_delay_ms AS double) / 12000.0) AS integer)
      END                     AS mempool_block_number
    FROM ethereum.transactions tx
    LEFT JOIN dune.flashbots.dataset_mempool_dumpster mp
      ON mp.hash = concat('0x', lower(to_hex(tx.hash)))
    WHERE tx."to" = ${byteaLiteral(router)}
      AND tx.block_date >= CURRENT_DATE - INTERVAL '${partitionDays}' DAY
      AND tx.block_time >= ${preciseFilter}
      AND tx.success = true
    ORDER BY tx.block_time DESC
    LIMIT ${limit}
  `;

  const windowLabel = useMinutes ? `${minutes}m` : `${days}d`;
  console.log(
    `[dune] queryProtocolTxsWithMempool router=${router.slice(0, 10)}... window=${windowLabel} limit=${limit}${useMinutes ? " (cache bypassed)" : ""}`
  );

  const executionId = await retryWithBackoff(
    async () => {
      const response = await axios.post(
        `${DUNE_API_URL}/sql/execute`,
        { sql, performance: "medium" },
        {
          headers: {
            "X-Dune-Api-Key": apiKey,
            "Content-Type": "application/json",
          },
          timeout: API_RATE_LIMITS.DUNE_QUERY_TIMEOUT_MS,
        }
      );
      console.log(`[dune] Protocol query submitted, execution_id: ${response.data.execution_id}`);
      return response.data.execution_id as string;
    },
    2,
    2000
  );

  // Poll until execution is in a terminal state, then follow `next_uri`
  // pagination until all rows are collected. Protocol queries may take
  // longer than the per-wallet lookup because they scan a whole day of
  // router txs.
  const duneHeaders = { "X-Dune-Api-Key": apiKey };
  const duneTimeout = API_RATE_LIMITS.DUNE_QUERY_TIMEOUT_MS;
  const resultsUrl = `${DUNE_API_URL}/execution/${executionId}/results`;

  let attempts = 0;
  const maxAttempts = 300; // up to 600s (10 min) of polling — partition-pruned
                           // queries usually finish in < 60s, but the first
                           // run per TTL sometimes needs partition-metadata
                           // warmup on Dune's side. 10 min is generous but
                           // still bounded.
  let rows: any[] = [];
  let firstPage: any = null;

  while (firstPage == null && attempts < maxAttempts) {
    await sleep(2000);
    attempts++;

    const resultsResponse = await axios.get(resultsUrl, {
      headers: duneHeaders,
      timeout: duneTimeout,
    });
    const data = resultsResponse.data;

    if (attempts % 5 === 0) {
      console.log(
        `[dune] Protocol poll #${attempts}: state=${data.state} finished=${!!data.is_execution_finished}`
      );
    }

    // `is_execution_finished` is the documented terminal-state flag
    // — use it rather than matching state strings.
    if (!data.is_execution_finished) continue;

    if (
      data.state === "QUERY_STATE_FAILED" ||
      data.state === "QUERY_STATE_CANCELED" ||
      data.state === "QUERY_STATE_EXPIRED"
    ) {
      // `error` is an object per Dune docs, not a string
      const errObj = data.error;
      const errMsg =
        typeof errObj === "string"
          ? errObj
          : errObj?.message || JSON.stringify(errObj) || "unknown error";
      throw new Error(`Dune protocol query ${data.state}: ${errMsg}`);
    }

    if (data.state === "QUERY_STATE_COMPLETED_PARTIAL") {
      console.warn(`[dune] Protocol query returned partial results`);
    }

    firstPage = data;
  }

  if (firstPage == null) {
    throw new Error("Dune protocol query timeout after 600 seconds");
  }

  // Collect first page
  rows.push(...(firstPage.result?.rows || []));

  // Follow next_uri until exhausted (EC-P1.6)
  let nextUri: string | undefined = firstPage.next_uri;
  while (nextUri) {
    const pageResponse = await axios.get(nextUri, {
      headers: duneHeaders,
      timeout: duneTimeout,
    });
    const pageRows = pageResponse.data.result?.rows || [];
    rows.push(...pageRows);
    nextUri = pageResponse.data.next_uri;
    if (rows.length % 1000 < pageRows.length) {
      console.log(`[dune] Protocol pagination: ${rows.length} rows so far`);
    }
  }

  console.log(`[dune] Protocol query complete, ${rows.length} rows total`);

  // Normalize rows. For windowDays mode we stream into the cache in
  // batches; for sub-day (windowMinutes) mode we skip cache writes entirely.
  const normalized: ProtocolTxRow[] = [];
  const batchBuffer: ProtocolTxRow[] = [];

  for (const row of rows) {
    const rawCalldata = normalizeBytesField(row.calldata);
    const rawValue = toDecimalString(row.value);
    const rawGasPrice = toDecimalString(row.gas_price);
    const mempoolTsRaw = row.mempool_timestamp_ms;
    const mempoolTs = mempoolTsRaw == null ? null : String(mempoolTsRaw);

    const tx: ProtocolTxRow = {
      txHash: normalizeBytesField(row.tx_hash).toLowerCase(),
      sender: normalizeBytesField(row.sender).toLowerCase(),
      to: normalizeBytesField(row.router).toLowerCase(),
      calldata: rawCalldata,
      value: rawValue,
      gasPrice: rawGasPrice,
      inclusionBlockNumber: Number(row.inclusion_block_number),
      inclusionBlockTime: String(row.inclusion_block_time),
      mempoolTimestampMs: mempoolTs,
      mempoolBlockNumber:
        row.mempool_block_number == null
          ? null
          : Number(row.mempool_block_number),
      inclusionDelayMs:
        row.inclusion_delay_ms == null
          ? null
          : Number(row.inclusion_delay_ms),
    };
    normalized.push(tx);

    if (!useMinutes) {
      batchBuffer.push(tx);
      if (batchBuffer.length >= PROTOCOL_PERSIST_BATCH) {
        await saveDuneProtocolTxsBatch(router, batchBuffer);
        batchBuffer.length = 0;
      }
    }
  }
  // Final flush for windowDays mode
  if (!useMinutes && batchBuffer.length > 0) {
    await saveDuneProtocolTxsBatch(router, batchBuffer);
    batchBuffer.length = 0;
  }

  // Marker last — gates cache hits. Must be written only after every row is
  // persisted. A crash before this line leaves the fetch invisible to the
  // cache-check path (no marker → null → re-fetch on next run).
  //
  // Sub-day windows (windowMinutes mode) skip the marker entirely to avoid
  // a `windowDays: 0` marker polluting the cache-check logic.
  if (!useMinutes) {
    await markDuneProtocolFetchComplete(router, days, normalized.length);
    console.log(
      `[dune] DuneProtocolFetch marker written: router=${router.slice(0, 10)}... windowDays=${days} rows=${normalized.length}`
    );
  } else {
    console.log(
      `[dune] Sub-day window (${minutes}m) — cache & marker bypassed, ${normalized.length} rows returned`
    );
  }

  return normalized;
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Dune SQL bytea literal for a 0x-prefixed hex address. */
function byteaLiteral(addr: string): string {
  const clean = addr.startsWith("0x") ? addr.slice(2) : addr;
  return `0x${clean}`;
}

/**
 * Dune returns bytes columns sometimes as 0x-prefixed hex strings and sometimes
 * as raw strings. Normalize to a lowercase 0x-prefixed hex string.
 */
function normalizeBytesField(value: unknown): string {
  if (value == null) return "0x";
  const s = String(value);
  if (s.startsWith("0x") || s.startsWith("0X")) return s.toLowerCase();
  if (/^[0-9a-fA-F]+$/.test(s)) return `0x${s.toLowerCase()}`;
  return s;
}

/**
 * Dune returns numeric columns as strings OR JS numbers. Normalize to a
 * decimal string (what Tenderly's `simulateTransaction` expects for
 * `value` / `gasPrice`).
 */
function toDecimalString(value: unknown): string {
  if (value == null) return "0";
  if (typeof value === "number") return Math.trunc(value).toString();
  const s = String(value);
  // Handles scientific notation Dune occasionally emits for huge values
  if (/^\d+$/.test(s)) return s;
  try {
    return BigInt(s).toString();
  } catch {
    // Fallback: strip decimal part if Dune returns "12345.0"
    const intPart = s.split(".")[0];
    return /^\d+$/.test(intPart) ? intPart : "0";
  }
}
