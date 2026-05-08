"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { formatUSD, truncateAddress } from "@/lib/utils";
import {
  Trophy,
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  Search,
  Zap,
  Activity,
} from "lucide-react";
import { motion } from "framer-motion";
import type { LeaderboardResponse } from "@/lib/types";

export default function WallOfShame() {
  const router = useRouter();
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<"totalLossUsd" | "txsSandwiched">("totalLossUsd");

  useEffect(() => {
    setIsLoading(true);
    fetch(`/api/leaderboard?page=${page}&limit=20`)
      .then((r) => { if (!r.ok) throw new Error("Failed"); return r.json(); })
      .then((data: LeaderboardResponse) => { setLeaderboard(data); setIsLoading(false); })
      .catch((err) => { setError(err instanceof Error ? err.message : "Error"); setIsLoading(false); });
  }, [page]);

  const hasEntries = leaderboard && leaderboard.entries.length > 0;
  const maxLoss = hasEntries ? Math.max(...leaderboard.entries.map((e) => e.totalLossUsd)) : 0;

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="mx-auto max-w-[900px] px-6 h-14 flex items-center">
          <button onClick={() => router.push("/")} className="flex items-center gap-3 text-muted-light hover:text-foreground transition-colors">
            <ArrowLeft className="w-4 h-4" />
            <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center text-white font-bold text-[15px]">E</div>
            <span className="font-bold text-[15px] text-foreground">Execution Gap</span>
          </button>
        </div>
      </nav>

      <main className="flex-1 mx-auto max-w-[900px] w-full px-6 py-10">
        {/* Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Trophy className="w-5 h-5 text-gold" />
              <h1 className="text-xl font-bold">Execution Gap Leaderboard</h1>
            </div>
            <p className="text-[13px] text-muted">Wallets ranked by total execution gap losses</p>
          </div>
          <div className="flex items-center gap-1">
            {["24h", "7d", "30d", "All time"].map((t) => (
              <button key={t} className={`px-3 py-1.5 text-[12px] font-medium rounded-lg transition-colors ${
                t === "All time" ? "gradient-bg text-white" : "text-muted hover:text-foreground hover:bg-white/[0.04]"
              }`}>{t}</button>
            ))}
          </div>
        </motion.div>

        {isLoading ? (
          <div className="rounded-2xl border border-white/[0.06] overflow-hidden">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-6 py-5 border-b border-white/[0.04] last:border-0">
                <div className="w-8 h-8 skeleton rounded-full" />
                <div className="w-36 h-5 skeleton rounded-md" />
                <div className="flex-1" />
                <div className="w-20 h-5 skeleton rounded-md" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="rounded-2xl border border-accent-red/20 bg-accent-red/[0.04] p-8 text-center">
            <AlertCircle className="w-6 h-6 text-accent-red mx-auto mb-2" />
            <p className="text-[14px] text-accent-red">{error}</p>
          </div>
        ) : !hasEntries ? (
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.015] py-24 flex flex-col items-center text-center">
            <div className="w-14 h-14 mb-6 rounded-2xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
              <Activity className="w-6 h-6 text-muted" />
            </div>
            <p className="text-[16px] font-semibold mb-2">No wallets analyzed yet</p>
            <p className="text-[14px] text-muted mb-8">Be the first to analyze a wallet</p>
            <button onClick={() => router.push("/")} className="inline-flex items-center gap-2 px-5 py-2.5 gradient-bg text-white text-[13px] font-semibold rounded-xl">
              <Search className="w-4 h-4" /> Analyze a Wallet
            </button>
          </div>
        ) : (
          <>
            {/* Top 3 Podium */}
            {page === 1 && leaderboard.entries.length >= 3 && (
              <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }}
                className="grid grid-cols-3 gap-3 mb-8">
                {[1, 0, 2].map((srcIdx) => {
                  const entry = leaderboard.entries[srcIdx];
                  const displayIdx = srcIdx === 0 ? 1 : srcIdx === 1 ? 0 : 2;
                  const colors = [
                    { ring: "ring-gold/30 bg-gold/10", text: "text-gold", top: "pt-0" },
                    { ring: "ring-silver/30 bg-silver/10", text: "text-silver", top: "pt-6" },
                    { ring: "ring-bronze/30 bg-bronze/10", text: "text-bronze", top: "pt-8" },
                  ];
                  const c = colors[displayIdx];
                  return (
                    <div key={entry.address} className={`${c.top} flex flex-col`}>
                      <div onClick={() => router.push(`/results/${entry.address}`)}
                        className="flex-1 rounded-2xl border border-white/[0.06] bg-card hover:bg-card-hover p-6 text-center cursor-pointer transition-colors">
                        <div className={`w-10 h-10 mx-auto mb-3 rounded-full ring-2 ${c.ring} flex items-center justify-center text-[14px] font-bold ${c.text}`}>
                          {entry.rank}
                        </div>
                        <p className="font-mono text-[12px] text-muted mb-2 truncate">{truncateAddress(entry.address, 4)}</p>
                        <p className="text-lg font-bold gradient-text tabular-nums">{formatUSD(entry.totalLossUsd)}</p>
                        <p className="text-[11px] text-muted mt-1">{entry.txsSandwiched} sandwiched</p>
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}

            {/* Table */}
            <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16 }}
              className="rounded-2xl border border-white/[0.06] overflow-hidden mb-6">
              <div className="grid grid-cols-[44px_1fr_130px_100px_100px] items-center px-6 py-3 bg-white/[0.02] border-b border-white/[0.06] text-[10px] font-semibold uppercase tracking-widest text-muted">
                <span>#</span>
                <span>Wallet</span>
                <button onClick={() => setSortBy("totalLossUsd")}
                  className={`text-right flex items-center justify-end gap-1 ${sortBy === "totalLossUsd" ? "text-accent-red" : ""}`}>
                  Total Loss {sortBy === "totalLossUsd" && <ChevronDown className="w-3 h-3" />}
                </button>
                <button onClick={() => setSortBy("txsSandwiched")}
                  className={`text-right flex items-center justify-end gap-1 ${sortBy === "txsSandwiched" ? "text-accent-red" : ""}`}>
                  Sandwiches {sortBy === "txsSandwiched" && <ChevronDown className="w-3 h-3" />}
                </button>
                <span className="text-right hidden sm:block">Slippage</span>
              </div>

              {leaderboard.entries
                .slice(page === 1 ? 3 : 0)
                .sort((a, b) => sortBy === "txsSandwiched" ? b.txsSandwiched - a.txsSandwiched : b.totalLossUsd - a.totalLossUsd)
                .map((entry) => {
                  const pct = maxLoss > 0 ? (entry.totalLossUsd / maxLoss) * 100 : 0;
                  return (
                    <div key={entry.address} onClick={() => router.push(`/results/${entry.address}`)}
                      className="grid grid-cols-[44px_1fr_130px_100px_100px] items-center px-6 py-4 border-b border-white/[0.04] last:border-0 hover:bg-white/[0.025] transition-colors cursor-pointer group">
                      <span className="text-[14px] text-muted font-medium pl-1">{entry.rank}</span>
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono text-[14px] text-foreground/80 group-hover:text-foreground transition-colors truncate">
                          {truncateAddress(entry.address, 6)}
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-[14px] font-bold gradient-text tabular-nums">{formatUSD(entry.totalLossUsd)}</span>
                        <div className="mt-1 h-[3px] rounded-full bg-white/[0.04] overflow-hidden">
                          <div className="h-full rounded-full gradient-bg" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                      <div className="text-right">
                        <span className="text-[14px] text-foreground/70 tabular-nums">{entry.txsSandwiched}</span>
                        <span className="text-[11px] text-muted ml-1">txns</span>
                      </div>
                      <span className="text-[14px] text-foreground/50 text-right tabular-nums hidden sm:block">
                        {formatUSD(entry.totalLossUsd * 0.28)}
                      </span>
                    </div>
                  );
                })}
            </motion.div>

            {/* Pagination */}
            <div className="flex items-center justify-between">
              <p className="text-[12px] text-muted tabular-nums">
                {(page - 1) * 20 + 1}–{Math.min(page * 20, leaderboard.totalWallets)} of {leaderboard.totalWallets}
              </p>
              <div className="flex items-center gap-1">
                <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1}
                  className="p-2 rounded-lg border border-white/[0.06] hover:bg-white/[0.04] disabled:opacity-25 transition-colors">
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                <span className="px-3 text-[12px] text-muted tabular-nums">{page} / {leaderboard.totalPages}</span>
                <button onClick={() => setPage(Math.min(leaderboard.totalPages, page + 1))} disabled={page === leaderboard.totalPages}
                  className="p-2 rounded-lg border border-white/[0.06] hover:bg-white/[0.04] disabled:opacity-25 transition-colors">
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </>
        )}

        {/* CTA */}
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
          className="mt-12 rounded-2xl border border-white/[0.06] bg-card p-8 text-center">
          <p className="text-[14px] text-muted mb-5">Discover your execution gap</p>
          <button onClick={() => router.push("/")}
            className="inline-flex items-center gap-2 px-6 py-2.5 gradient-bg text-white text-[14px] font-semibold rounded-xl hover:opacity-90 transition-opacity">
            <Search className="w-4 h-4" /> Analyze Your Wallet
          </button>
        </motion.div>
      </main>

      <footer className="border-t border-white/[0.04] py-6">
        <div className="mx-auto max-w-[900px] px-6 flex items-center justify-between">
          <p className="text-[12px] text-muted/50">All data is public and on-chain.</p>
          <p className="text-[12px] text-muted/40">Powered by <span className="gradient-text font-semibold">IntentGuard</span></p>
        </div>
      </footer>
    </div>
  );
}
