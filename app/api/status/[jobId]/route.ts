import { NextRequest, NextResponse } from "next/server";
import { getAnalysisJob } from "@/lib/db";
import { STATUS_MESSAGES } from "@/lib/constants";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  try {
    const { jobId } = await params;

    const job = await getAnalysisJob(jobId);

    if (!job) {
      return NextResponse.json(
        { error: "Job not found" },
        { status: 404 }
      );
    }

    const statusMessage = STATUS_MESSAGES[job.status as keyof typeof STATUS_MESSAGES] || "Processing";
    console.log(`[status] Job ${jobId}: ${job.status} (${job.progress}%) — ${statusMessage}`);

    return NextResponse.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      totalTxs: job.totalTxs,
      processedTxs: job.processedTxs,
      currentStep: statusMessage,
      error: job.error,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  } catch (error) {
    console.error("Error in status API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
