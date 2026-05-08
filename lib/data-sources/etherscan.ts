import axios from "axios";
import { retryWithBackoff } from "@/lib/utils";
import { rateLimiters } from "@/lib/rate-limiter";
import { ANALYSIS_WINDOW_DAYS, BLOCK_TIME_SECONDS } from "@/lib/constants";
import type { Transaction } from "@/lib/types";

const ETHERSCAN_API_URL = "https://api.etherscan.io/v2/api";
const CHAIN_ID = 1; // Ethereum mainnet

/**
 * Fetch latest block number from Etherscan
 */
async function getLatestBlockNumber(apiKey: string): Promise<number> {
  return rateLimiters.etherscan.execute(async () => {
    const { data } = await axios.get(ETHERSCAN_API_URL, {
      params: {
        chainid: CHAIN_ID,
        module: "proxy",
        action: "eth_blockNumber",
        apikey: apiKey,
      },
      timeout: 10000,
    });
    const blockHex = data.result;
    const blockNum = parseInt(blockHex, 16);
    console.log(`[etherscan] Latest block: ${blockNum} (${blockHex})`);
    return blockNum;
  });
}

interface EtherscanTx {
  hash: string;
  from: string;
  to: string;
  value: string;
  input: string;
  gas: string;
  gasPrice: string;
  gasUsed?: string;
  blockNumber: string;
  blockHash?: string;
  transactionIndex: string;
  isError: string;
  txreceipt_status?: string;
  timeStamp: string;
}

/**
 * Fetch transaction history for a wallet from Etherscan
 */
export async function fetchWalletTransactions(
  address: string,
  options?: { startBlockOverride?: number }
): Promise<{ transactions: Transaction[]; latestBlock: number }> {
  const apiKey = process.env.ETHERSCAN_API_KEY;

  if (!apiKey) {
    throw new Error(
      "ETHERSCAN_API_KEY not configured. Please set it in environment variables."
    );
  }

  // Etherscan enforces page * offset <= 10000, so we use pageSize=1000, max 10 pages.
  const transactions: Transaction[] = [];
  let page = 1;
  const pageSize = 1000;
  const maxPages = 10;

  // Fetch latest block number from Etherscan so our startBlock is accurate
  const latestBlock = await getLatestBlockNumber(apiKey);
  const blocksPerDay = Math.floor((24 * 60 * 60) / BLOCK_TIME_SECONDS); // 7200 blocks/day
  const windowBlocks = blocksPerDay * ANALYSIS_WINDOW_DAYS;
  const windowStartBlock = Math.max(0, latestBlock - windowBlocks);

  // Task 6: Use startBlockOverride for incremental fetching (lastFetchedBlock + 1)
  const startBlock = options?.startBlockOverride
    ? Math.max(windowStartBlock, options.startBlockOverride)
    : windowStartBlock;

  const isIncremental = !!options?.startBlockOverride;
  console.log(`[etherscan] ${isIncremental ? "INCREMENTAL" : "FULL"} fetch for ${address} — blocks ${startBlock}..${latestBlock} (~${latestBlock - startBlock} blocks), pageSize=${pageSize}, maxPages=${maxPages}`);

  while (page <= maxPages) {
    try {
      const response = await retryWithBackoff(
        async () => {
          return await rateLimiters.etherscan.execute(async () => {
            const requestUrl = `${ETHERSCAN_API_URL}?chainid=${CHAIN_ID}&module=account&action=txlist&page=${page}&offset=${pageSize}`;
            console.log(`[etherscan] GET page ${page} — ${requestUrl.split("?")[0]}`);

            const { data } = await axios.get(ETHERSCAN_API_URL, {
              params: {
                chainid: CHAIN_ID,
                module: "account",
                action: "txlist",
                address,
                startblock: startBlock,
                endblock: latestBlock,
                page,
                offset: pageSize,
                sort: "desc",
                apikey: apiKey,
              },
              timeout: 15000,
            });

            console.log(`[etherscan] Response status=${data.status}, message="${data.message}", rows=${data.result?.length ?? 0}`);

            if (data.status === "0") {
              if (data.message === "No transactions found") {
                console.log(`[etherscan] No transactions found for ${address}`);
                return [];
              }
              if (data.message?.includes("Result window is too large")) {
                console.warn(`[etherscan] Result window too large at page ${page} (page*offset=${page * pageSize} > 10000), stopping pagination`);
                return [];
              }
              throw new Error(`Etherscan API error: ${data.message}`);
            }

            return data.result || [];
          });
        },
        3,
        1000
      );

      if (!response || response.length === 0) {
        console.log(`[etherscan] Empty response at page ${page}, pagination complete`);
        break;
      }

      console.log(`[etherscan] Page ${page}: fetched ${response.length} txs (running total: ${transactions.length + response.length})`);
      transactions.push(
        ...response.map((tx: EtherscanTx) => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          input: tx.input,
          gas: tx.gas,
          gasPrice: tx.gasPrice,
          gasUsed: tx.gasUsed,
          blockNumber: parseInt(tx.blockNumber),
          blockHash: tx.blockHash,
          transactionIndex: parseInt(tx.transactionIndex),
          isError: tx.isError,
          txreceipt_status: tx.txreceipt_status,
          timeStamp: tx.timeStamp,
        }))
      );

      if (response.length < pageSize) {
        console.log(`[etherscan] Page ${page} returned ${response.length} < ${pageSize} (partial page), pagination complete`);
        break;
      }

      page++;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      console.error(`[etherscan] FAILED fetching txs for ${address} at page ${page}: ${errMsg}`);
      throw error;
    }
  }

  console.log(`[etherscan] Done: ${transactions.length} total transactions fetched for ${address} across ${page} page(s)`);
  return { transactions, latestBlock };
}

