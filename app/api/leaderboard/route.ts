import { NextRequest, NextResponse } from "next/server";
import { getLeaderboard } from "@/lib/db";
import { truncateAddress } from "@/lib/utils";
import { PAGINATION } from "@/lib/constants";

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(
      PAGINATION.MAX_LIMIT,
      parseInt(searchParams.get("limit") || String(PAGINATION.DEFAULT_LIMIT))
    );

    const leaderboard = await getLeaderboard(page, limit);

    return NextResponse.json({
      entries: leaderboard.entries.map((entry: any) => ({
        rank: entry.rank,
        address: entry.address,
        addressTruncated: truncateAddress(entry.address),
        totalLossUsd: entry.totalLossUsd,
        txsSandwiched: entry.txsSandwiched,
      })),
      totalWallets: leaderboard.total,
      page,
      limit,
      totalPages: leaderboard.totalPages,
    });
  } catch (error) {
    console.error("Error in leaderboard API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
