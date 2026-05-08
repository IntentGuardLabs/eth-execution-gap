import { NextRequest, NextResponse } from "next/server";
import { getWalletAnalysis, getWalletRank } from "@/lib/db";
import { isValidEthereumAddress, normalizeAddress, truncateAddress, formatUSD } from "@/lib/utils";

/**
 * Generate a simple text-based share card
 * In production, you'd use @vercel/og or satori for image generation
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ address: string }> }
) {
  try {
    const { address } = await params;

    // Validate address format
    if (!isValidEthereumAddress(address)) {
      return NextResponse.json(
        { error: "Invalid Ethereum address format" },
        { status: 400 }
      );
    }

    const normalizedAddress = normalizeAddress(address);
    const analysis = await getWalletAnalysis(normalizedAddress);

    if (!analysis) {
      return NextResponse.json(
        { error: "No analysis found for this address" },
        { status: 404 }
      );
    }

    const rank = await getWalletRank(normalizedAddress);

    // Generate SVG card
    const svg = generateShareCard({
      address: truncateAddress(normalizedAddress),
      totalLoss: formatUSD(analysis.totalLossUsd),
      rank: rank || 0,
      sandwichedTxs: analysis.txsSandwiched,
    });

    return new NextResponse(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch (error) {
    console.error("Error in share API:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

function generateShareCard(data: {
  address: string;
  totalLoss: string;
  rank: number;
  sandwichedTxs: number;
}): string {
  return `
    <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:#0a0a0f;stop-opacity:1" />
          <stop offset="100%" style="stop-color:#1a1a2e;stop-opacity:1" />
        </linearGradient>
      </defs>
      
      <rect width="1200" height="630" fill="url(#grad)"/>
      
      <!-- Border -->
      <rect x="20" y="20" width="1160" height="590" fill="none" stroke="#ff4444" stroke-width="3"/>
      
      <!-- Title -->
      <text x="600" y="100" font-family="monospace" font-size="48" font-weight="bold" fill="#ff4444" text-anchor="middle">
        Execution Gap Report
      </text>
      
      <!-- Address -->
      <text x="600" y="160" font-family="monospace" font-size="24" fill="#ffffff" text-anchor="middle">
        ${data.address}
      </text>
      
      <!-- Total Loss -->
      <text x="300" y="280" font-family="monospace" font-size="32" font-weight="bold" fill="#ff4444">
        Total Loss:
      </text>
      <text x="300" y="340" font-family="monospace" font-size="48" font-weight="bold" fill="#00ff00">
        ${data.totalLoss}
      </text>
      
      <!-- Rank -->
      <text x="900" y="280" font-family="monospace" font-size="32" font-weight="bold" fill="#ff4444">
        Rank:
      </text>
      <text x="900" y="340" font-family="monospace" font-size="48" font-weight="bold" fill="#00ff00">
        #${data.rank.toLocaleString()}
      </text>
      
      <!-- Sandwiched Txs -->
      <text x="300" y="450" font-family="monospace" font-size="24" fill="#ffaa00">
        Sandwiched Transactions: ${data.sandwichedTxs}
      </text>
      
      <!-- CTA -->
      <text x="600" y="550" font-family="monospace" font-size="20" fill="#ffffff" text-anchor="middle">
        Protect your future transactions with IntentGuard
      </text>
    </svg>
  `;
}
