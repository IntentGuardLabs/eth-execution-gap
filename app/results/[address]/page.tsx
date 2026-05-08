"use client";

import { useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  formatUSD,
  formatDateTime,
  getEtherscanTxUrl,
  truncateAddress,
} from "@/lib/utils";
import {
  AlertCircle,
  ArrowLeft,
  ShieldAlert,
  Clock,
  TrendingDown,
  ExternalLink,
  Loader2,
  Copy,
  Check,
  Shield,
  ChevronRight,
  Zap,
  Hash,
} from "lucide-react";
import { motion } from "framer-motion";
import type { WalletAnalysisResult, AnalysisJobStatus } from "@/lib/types";

interface ResultsPageProps {
  params: Promise<{ address: string }>;
}

const STEPS: Record<string, string> = {
  pending: "Preparing analysis...",
  fetching_txs: "Fetching transactions (last 180 days)",
  filtering: "Filtering out no-gap transactions",
  querying_mempool: "Querying mempool data",
  simulating: "Simulating transactions",
  calculating: "Calculating losses",
  complete: "Complete",
};

export default function ResultsPage({ params }: ResultsPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobId = searchParams.get("jobId");
  const [address, setAddress] = useState("");
  const [results, setResults] = useState<WalletAnalysisResult | null>(null);
  const [jobStatus, setJobStatus] = useState<AnalysisJobStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [startTime] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [completedSteps, setCompletedSteps] = useState<string[]>([]);

  useEffect(() => { params.then(({ address: a }) => setAddress(a)); }, [params]);

  // Elapsed timer
  useEffect(() => {
    if (!isLoading) return;
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isLoading, startTime]);

  useEffect(() => {
    if (!address || !jobId) return;
    let pollCount = 0;

    const pollStatus = async () => {
      try {
        pollCount++;
        const response = await fetch(`/api/status/${jobId}`);
        if (!response.ok) throw new Error("Failed to fetch status");
        const status: AnalysisJobStatus = await response.json();

        // Track step transitions
        if (jobStatus && status.status !== jobStatus.status && status.status !== "pending") {
          const stepLabel = STEPS[status.status] || status.currentStep || status.status;
          setCompletedSteps((prev) => {
            if (!prev.includes(stepLabel)) return [...prev, stepLabel];
            return prev;
          });
        }

        setJobStatus(status);

        if (status.status === "complete") {
          const r = await fetch(`/api/results/${address}`);
          if (!r.ok) throw new Error("Failed to fetch results");
          setResults(await r.json());
          setIsLoading(false);
        } else if (status.status === "error") {
          setError(status.error || "Analysis failed");
          setIsLoading(false);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "An error occurred");
        setIsLoading(false);
      }
    };
    pollStatus();
    const interval = setInterval(pollStatus, 2000);
    return () => clearInterval(interval);
  }, [address, jobId]);

  const copyAddress = () => {
    navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Loading
  if (isLoading) {
    const allSteps = [
      { key: "pending", label: "Preparing analysis" },
      { key: "fetching_txs", label: "Fetching transactions (180d)" },
      { key: "filtering", label: "Filtering out no-gap txs" },
      { key: "querying_mempool", label: "Querying mempool data" },
      { key: "simulating", label: "Simulating transactions" },
      { key: "calculating", label: "Calculating losses" },
    ];
    const currentStepIdx = allSteps.findIndex((s) => s.key === jobStatus?.status);
    const elapsedMin = Math.floor(elapsed / 60);
    const elapsedSec = elapsed % 60;

    return (
      <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0a0b0f", color: "#e8e6e1" }}>
        <Nav router={router} />
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 24px" }}>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            style={{ width: "100%", maxWidth: 420, textAlign: "center" }}
          >
            {/* Spinner */}
            <div style={{
              width: 64, height: 64, margin: "0 auto 24px", borderRadius: 16,
              background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.15)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Loader2 style={{ width: 28, height: 28, color: "#ef4444" }} className="animate-spin" />
            </div>

            {/* Current step */}
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              {jobStatus ? STEPS[jobStatus.status] || jobStatus.currentStep : "Starting analysis..."}
            </p>
            <p style={{ fontSize: 13, color: "#5a5d6b", marginBottom: 24 }}>
              {address && <span style={{ fontFamily: "var(--font-geist-mono), monospace" }}>{truncateAddress(address, 6)}</span>}
              {" · "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {elapsedMin > 0 ? `${elapsedMin}m ${elapsedSec}s` : `${elapsedSec}s`}
              </span>
            </p>

            {/* Progress bar */}
            {jobStatus && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ height: 6, borderRadius: 3, background: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
                  <motion.div
                    className="gradient-bg"
                    style={{ height: "100%", borderRadius: 3 }}
                    initial={{ width: 0 }}
                    animate={{ width: `${jobStatus.progress}%` }}
                    transition={{ duration: 0.5 }}
                  />
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontSize: 12, color: "#5a5d6b" }}>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>{jobStatus.progress}%</span>
                  {jobStatus.totalTxs && (
                    <span style={{ fontVariantNumeric: "tabular-nums" }}>
                      {jobStatus.processedTxs || 0} / {jobStatus.totalTxs} txs
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Step list */}
            <div style={{
              borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)",
              background: "#111218", textAlign: "left", overflow: "hidden",
            }}>
              {allSteps.map((step, i) => {
                const isDone = i < currentStepIdx;
                const isActive = i === currentStepIdx;
                const isPending = i > currentStepIdx;
                return (
                  <div
                    key={step.key}
                    style={{
                      display: "flex", alignItems: "center", gap: 10,
                      padding: "10px 16px",
                      borderBottom: i < allSteps.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                      opacity: isPending ? 0.35 : 1,
                    }}
                  >
                    {/* Status indicator */}
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      background: isDone ? "rgba(34,197,94,0.15)" : isActive ? "rgba(239,68,68,0.15)" : "rgba(255,255,255,0.04)",
                      flexShrink: 0,
                    }}>
                      {isDone ? (
                        <Check style={{ width: 12, height: 12, color: "#22c55e" }} />
                      ) : isActive ? (
                        <Loader2 style={{ width: 12, height: 12, color: "#ef4444" }} className="animate-spin" />
                      ) : (
                        <div style={{ width: 6, height: 6, borderRadius: "50%", background: "rgba(255,255,255,0.15)" }} />
                      )}
                    </div>
                    <span style={{
                      fontSize: 13,
                      fontWeight: isActive ? 600 : 400,
                      color: isDone ? "#22c55e" : isActive ? "#e8e6e1" : "#5a5d6b",
                    }}>
                      {step.label}
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Cancel button */}
            <button
              onClick={() => router.push("/")}
              style={{
                marginTop: 20, padding: "8px 20px",
                borderRadius: 10, border: "1px solid rgba(255,255,255,0.06)",
                background: "transparent", color: "#8b8d99",
                fontSize: 13, cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </motion.div>
        </div>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Nav router={router} />
        <div className="flex-1 flex items-center justify-center px-6">
          <div className="text-center max-w-sm">
            <AlertCircle className="w-10 h-10 text-accent-red mx-auto mb-4" />
            <h1 className="text-lg font-bold mb-2">Analysis Failed</h1>
            <p className="text-[14px] text-muted mb-6">{error}</p>
            <button onClick={() => router.push("/")} className="px-5 py-2.5 gradient-bg text-white text-[14px] font-semibold rounded-xl">
              Try Again
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!results) {
    return (
      <div className="min-h-screen flex flex-col bg-background">
        <Nav router={router} />
        <div className="flex-1 flex items-center justify-center">
          <p className="text-muted">No results found</p>
        </div>
      </div>
    );
  }

  // Results
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Nav router={router} />

      <main className="mx-auto max-w-[900px] w-full px-6 py-10">
        {/* Wallet Header */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="flex items-center gap-4 mb-10">
          <div className="w-12 h-12 rounded-full gradient-bg flex items-center justify-center text-white font-bold text-[14px]">
            {address.slice(2, 4).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-[16px] font-semibold">{truncateAddress(address, 8)}</h1>
              <button onClick={copyAddress} className="p-1 rounded-md hover:bg-white/[0.04] transition-colors">
                {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5 text-muted" />}
              </button>
            </div>
            <p className="text-[12px] text-muted">
              {results.rank && `Rank #${results.rank.toLocaleString()} · `}{formatDateTime(results.analyzedAt)}
            </p>
          </div>
        </motion.div>

        {/* Summary Cards */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 }} className="grid grid-cols-4 gap-3 mb-8">
          <div className="rounded-2xl border border-accent-red/20 bg-accent-red/[0.04] p-6">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-2">Total ({results.windowDays || 180}d)</p>
            <p className="text-3xl font-extrabold gradient-text tabular-nums">{formatUSD(results.totalLossUsd)}</p>
          </div>
          <div className="rounded-2xl border border-accent-red/20 bg-accent-red/[0.04] p-6">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-2">Annualized</p>
            <p className="text-3xl font-extrabold gradient-text tabular-nums">{formatUSD(results.annualizedLossUsd || results.totalLossUsd * (365 / (results.windowDays || 180)))}</p>
            <p className="text-[11px] text-muted mt-1">projected /year</p>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-card p-6">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-2">Analyzed</p>
            <p className="text-3xl font-extrabold tabular-nums">{results.txsAnalyzed}</p>
            <p className="text-[11px] text-muted mt-1">transactions</p>
          </div>
          <div className="rounded-2xl border border-white/[0.06] bg-card p-6">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted mb-2">Sandwiched</p>
            <p className="text-3xl font-extrabold text-accent-orange tabular-nums">{results.txsSandwiched}</p>
            <p className="text-[11px] text-muted mt-1">transactions</p>
          </div>
        </motion.div>

        {/* Breakdown */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.16 }} className="grid grid-cols-3 gap-3 mb-8">
          {[
            { label: "Sandwich Attacks", value: results.sandwichLossUsd, sub: `${results.txsSandwiched} txs`, emoji: "🥪" },
            { label: "Price Drift", value: results.delayLossUsd, sub: results.avgDelayMs ? `Avg ${results.avgDelayMs}ms` : "Timing gap", emoji: "📊" },
            { label: "Liquidity Drift", value: results.slippageLossUsd, sub: "Pool shifts", emoji: "💧" },
          ].map((c) => (
            <div key={c.label} className="rounded-2xl border border-white/[0.06] bg-card hover:bg-card-hover transition-colors p-5">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-[14px]">{c.emoji}</span>
                <span className="text-[12px] text-muted font-medium">{c.label}</span>
              </div>
              <p className="text-xl font-bold gradient-text tabular-nums mb-0.5">{formatUSD(c.value)}</p>
              <p className="text-[11px] text-muted">{c.sub}</p>
            </div>
          ))}
        </motion.div>

        {/* Worst Tx */}
        {results.worstTx && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.24 }}
            className="rounded-2xl border border-accent-red/20 bg-accent-red/[0.04] p-5 mb-8">
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-accent-red/10 flex items-center justify-center">
                  <AlertCircle className="w-5 h-5 text-accent-red" />
                </div>
                <div>
                  <p className="text-[11px] text-muted mb-0.5">Worst Transaction</p>
                  <a href={getEtherscanTxUrl(results.worstTx.hash)} target="_blank" rel="noopener noreferrer"
                    className="font-mono text-[13px] text-foreground hover:text-accent-red transition-colors inline-flex items-center gap-1">
                    {truncateAddress(results.worstTx.hash, 10)} <ExternalLink className="w-3 h-3" />
                  </a>
                </div>
              </div>
              <div className="text-right">
                <p className="text-xl font-bold gradient-text tabular-nums">-{formatUSD(results.worstTx.lossUsd)}</p>
                <p className="text-[11px] text-muted capitalize">{results.worstTx.type}</p>
              </div>
            </div>
          </motion.div>
        )}

        {/* Transactions Table */}
        {results.transactions.length > 0 && (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.32 }}
            className="rounded-2xl border border-white/[0.06] overflow-hidden mb-10">
            <div className="px-6 py-3.5 border-b border-white/[0.06] bg-white/[0.02] flex items-center gap-2">
              <Hash className="w-4 h-4 text-muted" />
              <h3 className="text-[14px] font-semibold">Transactions</h3>
              <span className="text-[12px] text-muted">({results.transactions.length})</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-white/[0.04] bg-white/[0.01]">
                    <th className="px-6 py-2.5 text-left text-[10px] text-muted font-semibold uppercase tracking-widest">Hash</th>
                    <th className="px-6 py-2.5 text-left text-[10px] text-muted font-semibold uppercase tracking-widest">Token</th>
                    <th className="px-6 py-2.5 text-left text-[10px] text-muted font-semibold uppercase tracking-widest">Type</th>
                    <th className="px-6 py-2.5 text-right text-[10px] text-muted font-semibold uppercase tracking-widest">Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {results.transactions.slice(0, 15).map((tx) => (
                    <tr key={tx.txHash} className="border-b border-white/[0.03] last:border-0 hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-3.5">
                        <a href={getEtherscanTxUrl(tx.txHash)} target="_blank" rel="noopener noreferrer"
                          className="font-mono text-[12px] text-foreground/60 hover:text-accent-red transition-colors inline-flex items-center gap-1">
                          {truncateAddress(tx.txHash, 6)} <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      </td>
                      <td className="px-6 py-3.5 text-foreground/70">{tx.tokenSymbol || "Unknown"}</td>
                      <td className="px-6 py-3.5">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold uppercase tracking-wider ${
                          tx.gapType === "sandwich" ? "bg-accent-red/8 text-accent-red"
                          : tx.gapType === "delay" ? "bg-accent-orange/8 text-accent-orange"
                          : "bg-accent-purple/8 text-accent-purple"
                        }`}>
                          {tx.gapType === "sandwich" ? "🥪" : tx.gapType === "delay" ? "📊" : "💧"} {tx.gapType}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-right font-bold gradient-text tabular-nums">
                        -{formatUSD(tx.gapUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </motion.div>
        )}

        {/* CTA */}
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.4 }}
          className="rounded-2xl border border-accent-red/15 bg-accent-red/[0.03] p-10 text-center">
          <div className="w-12 h-12 mx-auto mb-4 rounded-2xl gradient-bg/10 border border-accent-red/20 flex items-center justify-center">
            <Shield className="w-5 h-5 text-accent-red" />
          </div>
          <h3 className="text-lg font-bold mb-2">Close Your Execution Gap</h3>
          <p className="text-[14px] text-muted mb-6 max-w-md mx-auto leading-relaxed">
            Enable IntentGuard to protect your swaps from price drift, spoofing, and sandwich attacks.
          </p>
          <a href={process.env.NEXT_PUBLIC_INTENTGUARD_URL || "#"}
            className="inline-flex items-center gap-2 px-7 py-3 gradient-bg text-white text-[14px] font-semibold rounded-xl hover:opacity-90 transition-opacity">
            Enable Protection <ChevronRight className="w-4 h-4" />
          </a>
        </motion.div>
      </main>

      <footer className="border-t border-white/[0.04] py-6">
        <div className="mx-auto max-w-[900px] px-6 flex items-center justify-between">
          <p className="text-[12px] text-muted/50">Analysis completed {formatDateTime(results.analyzedAt)}</p>
          <p className="text-[12px] text-muted/40">Powered by <span className="gradient-text font-semibold">IntentGuard</span></p>
        </div>
      </footer>
    </div>
  );
}

function Nav({ router }: { router: ReturnType<typeof useRouter> }) {
  return (
    <nav className="sticky top-0 z-50 bg-background/80 backdrop-blur-xl border-b border-white/[0.06]">
      <div className="mx-auto max-w-[900px] px-6 h-14 flex items-center">
        <button onClick={() => router.push("/")} className="flex items-center gap-3 text-muted-light hover:text-foreground transition-colors">
          <ArrowLeft className="w-4 h-4" />
          <div className="w-8 h-8 rounded-lg gradient-bg flex items-center justify-center text-white font-bold text-[15px]">E</div>
          <span className="font-bold text-[15px] text-foreground">Execution Gap</span>
        </button>
      </div>
    </nav>
  );
}
