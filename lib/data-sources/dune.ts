import axios from "axios";
import { retryWithBackoff, sleep } from "@/lib/utils";
import { API_RATE_LIMITS } from "@/lib/constants";
import type { MempoolData } from "@/lib/types";

const DUNE_API_URL = "https://api.dune.com/api/v1";

/**
 * Query Dune Analytics for mempool data
 */
export async function queryMempoolData(txHashes: string[]): Promise<Map<string, MempoolData>> {
  const apiKey = process.env.DUNE_API_KEY;

  if (!apiKey) {
    throw new Error(
      "DUNE_API_KEY not configured. Please set it in environment variables."
    );
  }

  if (txHashes.length === 0) {
    return new Map();
  }

  const results = new Map<string, MempoolData>();

  try {
    // Format tx hashes for SQL query
    const hashList = txHashes
      .map((h) => `'${h.toLowerCase()}'`)
      .join(",");

    const sql = `
      SELECT
        mp.hash,
        mp.timestamp_ms,
        mp.inclusion_delay_ms,
        mp.included_at_block_height,
        b.number as mempool_block_number,
        b.time as mempool_block_time
      FROM flashbots.dataset_mempool_dumpster mp
      LEFT JOIN ethereum.blocks b
        ON b.time <= from_unixtime(mp.timestamp_ms / 1000)
        AND b.time > from_unixtime(mp.timestamp_ms / 1000 - 13)
      WHERE mp.hash IN (${hashList})
      ORDER BY mp.hash, b.time DESC
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

    // Poll for results using the results endpoint (includes status)
    let isComplete = false;
    let attempts = 0;
    const maxAttempts = 60; // 60 * 2s = 120 seconds timeout

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
        for (const [hash, rows] of groupedByHash.entries()) {
          if (rows.length > 0) {
            const row = rows[0];
            results.set(hash, {
              hash: row.hash,
              timestamp_ms: row.timestamp_ms,
              inclusion_delay_ms: row.inclusion_delay_ms,
              included_at_block_height: row.included_at_block_height,
              mempool_block_number: row.mempool_block_number || row.included_at_block_height - 1,
              mempool_block_time: row.mempool_block_time,
            });
          }
        }

        console.log(`[dune] Query complete, got mempool data for ${results.size} txs`);
      } else if (state === "QUERY_STATE_FAILED" || state === "QUERY_STATE_CANCELED" || state === "QUERY_STATE_EXPIRED") {
        throw new Error(
          `Dune query ${state}: ${resultsResponse.data.error || "unknown error"}`
        );
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
 * Get mempool data for a single transaction
 */
export async function getMempoolDataForTx(txHash: string): Promise<MempoolData | null> {
  try {
    const results = await queryMempoolData([txHash]);
    return results.get(txHash.toLowerCase()) || null;
  } catch (error) {
    console.error(`[dune] Error getting mempool data for ${txHash}:`, error);
    return null;
  }
}

/**
 * Fallback: estimate mempool block number from inclusion block
 */
export function estimateMempoolBlockNumber(includedAtBlockHeight: number): number {
  // Conservative estimate: mempool block is one block before inclusion
  return Math.max(0, includedAtBlockHeight - 1);
}
