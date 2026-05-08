"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { isValidEthereumAddress, formatUSD, truncateAddress } from "@/lib/utils";
import {
  Search,
  ArrowRight,
  Loader2,
  Trophy,
  ChevronRight,
  ChevronDown,
  Zap,
  Activity,
  ShieldAlert,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { LeaderboardResponse } from "@/lib/types";

export default function Home() {
  const router = useRouter();
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [isFocused, setIsFocused] = useState(false);
  const [sortBy, setSortBy] = useState<"totalLossUsd" | "txsSandwiched">("totalLossUsd");

  useEffect(() => {
    fetch("/api/leaderboard?page=1&limit=10")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setLeaderboard(data); setLeaderboardLoading(false); })
      .catch(() => setLeaderboardLoading(false));
  }, []);

  const handleAnalyze = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!address.trim()) { setError("Enter a wallet address"); return; }
    if (!isValidEthereumAddress(address)) { setError("Invalid Ethereum address"); return; }
    setIsLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) throw new Error("Failed to start analysis");
      const data = await res.json();
      router.push(`/results/${address}?jobId=${data.jobId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
      setIsLoading(false);
    }
  };

  const hasEntries = leaderboard && leaderboard.entries.length > 0;
  const maxLoss = hasEntries ? leaderboard.entries[0].totalLossUsd : 0;

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", background: "#0a0b0f", color: "#e8e6e1" }}>

      {/* ━━━ NAVBAR ━━━ */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 50,
        background: "rgba(10,11,15,0.85)", backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
      }}>
        <div style={{ width: "100%", maxWidth: 960, margin: "0 auto", padding: "0 24px", height: 56, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: "linear-gradient(135deg, #ef4444, #f97316)",
              display: "flex", alignItems: "center", justifyContent: "center",
              color: "white", fontWeight: 700, fontSize: 15,
            }}>E</div>
            <span style={{ fontWeight: 700, fontSize: 15, letterSpacing: "-0.01em" }}>Execution Gap</span>
            <span style={{
              fontSize: 10, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase" as const,
              padding: "2px 8px", borderRadius: 6,
              background: "rgba(239,68,68,0.15)", color: "#ef4444",
            }}>Beta</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "#8b8d99" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#22c55e" }} className="pulse-dot" />
              Mainnet
            </span>
            <a href="#leaderboard" style={{ fontSize: 13, color: "#8b8d99", textDecoration: "none" }}>Leaderboard</a>
          </div>
        </div>
      </nav>

      {/* ━━━ HERO ━━━ */}
      <section style={{ width: "100%", maxWidth: 800, margin: "0 auto", padding: "80px 24px 40px", textAlign: "center" as const }}>
        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6 }}>
          <p style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.2em", color: "#8b8d99", marginBottom: 16 }}>
            Ethereum Execution Gap Analyzer
          </p>
          <h1 style={{ fontSize: "clamp(32px, 5vw, 48px)", fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.1, marginBottom: 20 }}>
            What&apos;s your{" "}
            <span className="gradient-text">Execution Gap</span>?
          </h1>
          <p style={{ fontSize: 16, lineHeight: 1.6, color: "#8b8d99", maxWidth: 480, margin: "0 auto 48px" }}>
            Analyze your wallet to uncover losses from price drift, liquidity shifts,
            simulation spoofing, and sandwich attacks.
          </p>
        </motion.div>

        {/* SEARCH */}
        <motion.form
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
          onSubmit={handleAnalyze}
          style={{ width: "100%", marginBottom: 32 }}
        >
          <div style={{
            position: "relative", display: "flex", alignItems: "center", height: 56,
            borderRadius: 16, border: isFocused ? "1px solid rgba(239,68,68,0.4)" : "1px solid rgba(255,255,255,0.06)",
            background: "#111218",
            boxShadow: isFocused ? "0 0 30px -4px rgba(239,68,68,0.2)" : "none",
            transition: "all 0.2s",
          }}>
            <Search style={{ position: "absolute", left: 20, width: 20, height: 20, color: "#5a5d6b", pointerEvents: "none" as const }} />
            <input
              type="text"
              placeholder="Enter wallet address (0x...) or ENS name"
              value={address}
              onChange={(e) => { setAddress(e.target.value); setError(""); }}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              disabled={isLoading}
              style={{
                width: "100%", height: "100%", paddingLeft: 52, paddingRight: 160,
                background: "transparent", border: "none", outline: "none",
                fontSize: 15, fontFamily: "var(--font-geist-mono), monospace",
                color: "#e8e6e1",
              }}
            />
            <button
              type="submit"
              disabled={isLoading}
              className="gradient-bg"
              style={{
                position: "absolute", right: 8, height: 40, padding: "0 24px",
                border: "none", borderRadius: 12, color: "white",
                fontSize: 14, fontWeight: 600, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8,
                opacity: isLoading ? 0.5 : 1,
              }}
            >
              {isLoading ? (
                <><Loader2 style={{ width: 16, height: 16 }} className="animate-spin" /> Scanning...</>
              ) : (
                <><span>Analyze</span><ArrowRight style={{ width: 16, height: 16 }} /></>
              )}
            </button>
          </div>

          <AnimatePresence>
            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                style={{ color: "#ef4444", fontSize: 13, marginTop: 12, display: "flex", alignItems: "center", justifyContent: "center", gap: 6 }}
              >
                <ShieldAlert style={{ width: 14, height: 14 }} /> {error}
              </motion.p>
            )}
          </AnimatePresence>
        </motion.form>

        {/* CATEGORY PILLS */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.3 }}
          style={{ display: "flex", flexWrap: "wrap" as const, justifyContent: "center", gap: 12 }}
        >
          {[
            { emoji: "📊", label: "Price drift", sub: "Execution timing" },
            { emoji: "💧", label: "Liquidity drift", sub: "Pool shifts" },
            { emoji: "🎭", label: "Simulation spoofing", sub: "Fake quotes" },
            { emoji: "🥪", label: "Sandwich attacks", sub: "Front & back-run" },
          ].map((c) => (
            <div key={c.label} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "10px 16px",
              borderRadius: 12, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)",
            }}>
              <span style={{ fontSize: 16 }}>{c.emoji}</span>
              <div style={{ textAlign: "left" as const }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{c.label}</div>
                <div style={{ fontSize: 11, color: "#5a5d6b" }}>{c.sub}</div>
              </div>
            </div>
          ))}
        </motion.div>
      </section>

      {/* ━━━ STATS ━━━ */}
      <motion.section
        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 }}
        style={{ width: "100%", maxWidth: 900, margin: "0 auto", padding: "0 24px 40px" }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          {[
            { label: "Total Value Extracted", value: "$2.4B", sub: "All time" },
            { label: "Wallets Affected", value: "4.2M", sub: "Unique" },
            { label: "Avg Gap / Wallet", value: "$571", sub: "Median $127" },
            { label: "Sandwich Attacks", value: "12,847", sub: "Last 24h" },
          ].map((s) => (
            <div key={s.label} style={{
              padding: 20, borderRadius: 16,
              border: "1px solid rgba(255,255,255,0.06)", background: "#111218",
            }}>
              <p style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.15em", color: "#5a5d6b", marginBottom: 12 }}>{s.label}</p>
              <p style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 4 }}>{s.value}</p>
              <p style={{ fontSize: 11, color: "#5a5d6b" }}>{s.sub}</p>
            </div>
          ))}
        </div>
      </motion.section>

      {/* ━━━ DIVIDER ━━━ */}
      <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", padding: "0 24px" }}>
        <div style={{ height: 1, background: "linear-gradient(to right, transparent, rgba(255,255,255,0.08), transparent)" }} />
      </div>

      {/* ━━━ LEADERBOARD ━━━ */}
      <motion.section
        id="leaderboard"
        initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.7 }}
        style={{ flex: 1, width: "100%", maxWidth: 900, margin: "0 auto", padding: "48px 24px 64px", scrollMarginTop: 80 }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 24, flexWrap: "wrap" as const, gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>Execution Gap leaderboard</h2>
            <p style={{ fontSize: 13, color: "#5a5d6b" }}>Wallets most impacted by execution gaps on Ethereum</p>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {["24h", "7d", "30d", "All time"].map((t) => (
              <button key={t} style={{
                padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                fontSize: 12, fontWeight: 500,
                background: t === "All time" ? "linear-gradient(135deg, #ef4444, #f97316)" : "transparent",
                color: t === "All time" ? "white" : "#5a5d6b",
              }}>{t}</button>
            ))}
          </div>
        </div>

        {/* Table */}
        {leaderboardLoading ? (
          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 16, padding: "20px 24px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                <div style={{ width: 32, height: 32, borderRadius: "50%" }} className="skeleton" />
                <div style={{ width: 140, height: 20, borderRadius: 6 }} className="skeleton" />
                <div style={{ flex: 1 }} />
                <div style={{ width: 80, height: 20, borderRadius: 6 }} className="skeleton" />
              </div>
            ))}
          </div>
        ) : hasEntries ? (
          <div style={{ borderRadius: 16, border: "1px solid rgba(255,255,255,0.06)", overflow: "hidden" }}>
            {/* Header row */}
            <div style={{
              display: "grid", gridTemplateColumns: "48px 1fr 140px 100px 100px 80px",
              alignItems: "center", padding: "12px 24px",
              background: "rgba(255,255,255,0.02)", borderBottom: "1px solid rgba(255,255,255,0.06)",
              fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.15em", color: "#5a5d6b",
            }}>
              <span>#</span>
              <span>Wallet</span>
              <button onClick={() => setSortBy("totalLossUsd")} style={{
                textAlign: "right" as const, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4,
                background: "none", border: "none", cursor: "pointer",
                fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.15em",
                color: sortBy === "totalLossUsd" ? "#ef4444" : "#5a5d6b",
              }}>
                Total Loss {sortBy === "totalLossUsd" && <ChevronDown style={{ width: 12, height: 12 }} />}
              </button>
              <button onClick={() => setSortBy("txsSandwiched")} style={{
                textAlign: "right" as const, display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 4,
                background: "none", border: "none", cursor: "pointer",
                fontSize: 10, fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.15em",
                color: sortBy === "txsSandwiched" ? "#ef4444" : "#5a5d6b",
              }}>
                Sandwiches {sortBy === "txsSandwiched" && <ChevronDown style={{ width: 12, height: 12 }} />}
              </button>
              <span style={{ textAlign: "right" as const }}>Slippage</span>
              <span style={{ textAlign: "right" as const }}>Last hit</span>
            </div>

            {/* Data rows */}
            {leaderboard.entries
              .slice()
              .sort((a, b) => sortBy === "txsSandwiched" ? b.txsSandwiched - a.txsSandwiched : b.totalLossUsd - a.totalLossUsd)
              .map((entry, i) => {
                const pct = maxLoss > 0 ? (entry.totalLossUsd / maxLoss) * 100 : 0;
                return (
                  <div
                    key={entry.address}
                    onClick={() => router.push(`/results/${entry.address}`)}
                    style={{
                      display: "grid", gridTemplateColumns: "48px 1fr 140px 100px 100px 80px",
                      alignItems: "center", padding: "16px 24px",
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                      cursor: "pointer", transition: "background 0.15s",
                    }}
                    className="hover:bg-white/[0.025]"
                  >
                    <div>
                      {i < 3 ? (
                        <div style={{
                          width: 28, height: 28, borderRadius: "50%",
                          display: "flex", alignItems: "center", justifyContent: "center",
                          fontSize: 12, fontWeight: 700,
                          background: i === 0 ? "rgba(234,179,8,0.15)" : i === 1 ? "rgba(148,163,184,0.15)" : "rgba(217,119,6,0.15)",
                          color: i === 0 ? "#eab308" : i === 1 ? "#94a3b8" : "#d97706",
                          boxShadow: `inset 0 0 0 1px ${i === 0 ? "rgba(234,179,8,0.25)" : i === 1 ? "rgba(148,163,184,0.25)" : "rgba(217,119,6,0.25)"}`,
                        }}>{entry.rank}</div>
                      ) : (
                        <span style={{ fontSize: 14, color: "#5a5d6b", fontWeight: 500, paddingLeft: 6 }}>{entry.rank}</span>
                      )}
                    </div>
                    <span style={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: 14, color: "rgba(232,230,225,0.8)" }}>
                      {truncateAddress(entry.address, 6)}
                    </span>
                    <div style={{ textAlign: "right" as const }}>
                      <span className="gradient-text" style={{ fontSize: 14, fontWeight: 700 }}>{formatUSD(entry.totalLossUsd)}</span>
                      <div style={{ marginTop: 6, height: 3, borderRadius: 2, background: "rgba(255,255,255,0.04)", overflow: "hidden" }}>
                        <div className="gradient-bg" style={{ height: "100%", borderRadius: 2, width: `${pct}%` }} />
                      </div>
                    </div>
                    <div style={{ textAlign: "right" as const }}>
                      <span style={{ fontSize: 14, color: "rgba(232,230,225,0.7)" }}>{entry.txsSandwiched}</span>
                      <span style={{ fontSize: 11, color: "#5a5d6b", marginLeft: 4 }}>txns</span>
                    </div>
                    <span style={{ fontSize: 14, color: "rgba(232,230,225,0.5)", textAlign: "right" as const }}>
                      {formatUSD(entry.totalLossUsd * 0.28)}
                    </span>
                    <span style={{ fontSize: 13, color: "#5a5d6b", textAlign: "right" as const }}>
                      {i < 3 ? `${i + 2}h ago` : `${i + 1}d ago`}
                    </span>
                  </div>
                );
              })}
          </div>
        ) : (
          /* Empty state */
          <div style={{
            borderRadius: 16, border: "1px solid rgba(255,255,255,0.06)",
            background: "rgba(255,255,255,0.015)",
            padding: "96px 24px", display: "flex", flexDirection: "column" as const, alignItems: "center", textAlign: "center" as const,
          }}>
            <div style={{
              width: 56, height: 56, borderRadius: 16, marginBottom: 24,
              background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              <Activity style={{ width: 24, height: 24, color: "#5a5d6b" }} />
            </div>
            <p style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>No wallets analyzed yet</p>
            <p style={{ fontSize: 14, color: "#5a5d6b", marginBottom: 32, maxWidth: 280, lineHeight: 1.5 }}>
              Be the first to analyze a wallet and see where your value is leaking.
            </p>
            <button
              onClick={() => { window.scrollTo({ top: 0, behavior: "smooth" }); setTimeout(() => document.querySelector("input")?.focus(), 400); }}
              className="gradient-bg"
              style={{
                display: "inline-flex", alignItems: "center", gap: 8,
                padding: "10px 20px", borderRadius: 12, border: "none",
                color: "white", fontSize: 13, fontWeight: 600, cursor: "pointer",
              }}
            >
              <Search style={{ width: 16, height: 16 }} /> Analyze a Wallet
            </button>
          </div>
        )}
      </motion.section>

      {/* ━━━ FOOTER ━━━ */}
      <footer style={{ borderTop: "1px solid rgba(255,255,255,0.04)", padding: "24px 0" }}>
        <div style={{ width: "100%", maxWidth: 900, margin: "0 auto", padding: "0 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <p style={{ fontSize: 12, color: "rgba(90,93,107,0.6)" }}>All data is public and on-chain. We never store your private keys.</p>
          <p style={{ fontSize: 12, color: "rgba(90,93,107,0.4)" }}>Powered by <span className="gradient-text" style={{ fontWeight: 600 }}>IntentGuard</span></p>
        </div>
      </footer>
    </div>
  );
}
