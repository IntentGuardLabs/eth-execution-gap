import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getOrCreateAnalysisJob, getWalletAnalysis, updateAnalysisJobStatus } from "@/lib/db";
import { jobQueue } from "@/lib/job-queue";
import { analyzeWallet } from "@/lib/analysis/pipeline";
import { isValidEthereumAddress, normalizeAddress } from "@/lib/utils";

const analyzeRequestSchema = z.object({
  address: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { address } = analyzeRequestSchema.parse(body);

    if (!isValidEthereumAddress(address)) {
      return NextResponse.json(
        { error: "Invalid Ethereum address format" },
        { status: 400 }
      );
    }

    const normalizedAddress = normalizeAddress(address);

    // ── Step 1: Check if we already have results in the DB ──
    const existing = await getWalletAnalysis(normalizedAddress);
    if (existing) {
      const ageHours = ((Date.now() - new Date(existing.analyzedAt).getTime()) / (1000 * 60 * 60)).toFixed(1);
      console.log(`[analyze] Found existing results for ${normalizedAddress} — analyzed ${ageHours}h ago (${existing.txsAnalyzed} txs, $${existing.totalLossUsd.toFixed(2)} loss)`);

      // Find or create a "complete" job so the frontend polling works
      const job = await getOrCreateAnalysisJob(normalizedAddress);
      if (job.status !== "complete") {
        await updateAnalysisJobStatus(job.id, "complete", 100);
      }

      return NextResponse.json({
        jobId: job.id,
        status: "complete",
        progress: 100,
      });
    } else {
      console.log(`[analyze] No existing results for ${normalizedAddress} — will perform new analysis`);
    }

    // ── Step 2: Check for missing API keys ──
    const missingKeys: string[] = [];
    if (!process.env.ETHERSCAN_API_KEY) missingKeys.push("ETHERSCAN_API_KEY");
    if (!process.env.DUNE_API_KEY) missingKeys.push("DUNE_API_KEY");
    if (!process.env.TENDERLY_ACCOUNT || !process.env.TENDERLY_PROJECT || !process.env.TENDERLY_API_KEY) {
      missingKeys.push("TENDERLY_ACCOUNT/PROJECT/API_KEY");
    }
    if (missingKeys.length > 0) {
      console.warn(`[analyze] Missing API keys: ${missingKeys.join(", ")} — pipeline may fail`);
    }

    // ── Step 3: Get or create a job ──
    const job = await getOrCreateAnalysisJob(normalizedAddress);

    // If job is already complete (from a concurrent request), return it
    if (job.status === "complete") {
      console.log(`[analyze] Job ${job.id} already complete for ${normalizedAddress}`);
      return NextResponse.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
      });
    }

    // If already in-progress in the queue, don't double-queue
    if (jobQueue.isJobQueued(job.id)) {
      console.log(`[analyze] Job ${job.id} already queued/running for ${normalizedAddress}`);
      return NextResponse.json({
        jobId: job.id,
        status: job.status,
        progress: job.progress,
      });
    }

    // ── Step 4: Queue the analysis ──
    console.log(`[analyze] Queuing NEW job ${job.id} for ${normalizedAddress}`);
    await updateAnalysisJobStatus(job.id, "pending", 0);

    jobQueue.addJob(job.id, normalizedAddress, async (jobId) => {
      console.log(`[analyze] Pipeline START for job ${jobId} (${normalizedAddress})`);
      const startMs = Date.now();
      await analyzeWallet(jobId, normalizedAddress);
      const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
      console.log(`[analyze] Pipeline COMPLETE for job ${jobId} in ${durationSec}s`);
    });

    return NextResponse.json({
      jobId: job.id,
      status: "pending",
      progress: 0,
    });
  } catch (error) {
    console.error("[analyze] Error:", error);

    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Invalid request body", details: error.issues },
        { status: 400 }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
