# Blueprint 06: UI States

> Version: 1.0 | Last updated: 2026-04-11 | Source of truth for: `app/page.tsx`, `app/results/[address]/page.tsx`, `app/wall-of-shame/page.tsx`

What the user sees at each stage of interaction. If the code differs from this document, this document wins until explicitly updated.

## Changelog

- 2026-04-11: Initial version — documented from actual codebase

---

## Navigation Flow

```
/  (Landing Page)
 ├── Submit form → /results/{address}?jobId={id}    [new analysis]
 ├── Click leaderboard row → /results/{address}      [cached results, no jobId]
 └── "Leaderboard" nav → in-page scroll #leaderboard

/wall-of-shame  (Full Leaderboard)
 ├── Click podium card → /results/{address}
 ├── Click table row → /results/{address}
 └── Back / logo → /

/results/{address}  (Results Dashboard)
 └── Back / logo / Cancel / Try Again → /
```

---

## Page 1: Landing Page (`app/page.tsx`)

### URL: `/`

### Data Dependencies

| Source | Trigger | Frequency |
|--------|---------|-----------|
| `GET /api/leaderboard?page=1&limit=10` | On mount | Once (no refresh) |
| `POST /api/analyze` | Form submit | On demand |

### States

#### State 1.1: Initial Load (Leaderboard Loading)

- **Trigger**: Page mount, before leaderboard fetch completes
- **Search form**: Fully usable — input enabled, button active
- **Leaderboard area**: 6 skeleton rows pulsing
- **Stats section**: 4 hardcoded stat cards (static placeholders, not from API)

#### State 1.2: Idle (Leaderboard Populated)

- **Search form**: Input accepts `0x...` hex addresses. Placeholder mentions ENS but ENS resolution is not implemented.
- **Leaderboard table**: Ranked entries with columns: Rank, Address (truncated), Total Loss (with CSS bar), Sandwiched count, Slippage, Last hit
  - **Slippage column**: fabricated — `totalLossUsd * 0.28` (see Shared UI Patterns below)
  - **Last hit column**: fabricated — shows `"{i+2}h ago"` for top 3, `"{i+1}d ago"` for rest. Based on row index, not API data.
- **Sortable columns**: "Total Loss" and "Sandwiches" headers toggle client-side sort (no re-fetch)
- **Time period buttons**: 24h / 7d / 30d / All time — **decorative only**, no click handlers. "All time" styled as active.

#### State 1.3: Idle (Leaderboard Empty)

- **Trigger**: Leaderboard API returns 0 entries
- **Leaderboard area**: `Activity` icon, "No wallets analyzed yet" message, CTA button that scrolls to top and focuses input

#### State 1.4: Analyzing (Form Submitted)

- **Trigger**: User submits valid address
- **Input**: Disabled
- **Button**: `Loader2` spinner + "Scanning..." text
- **Duration**: Brief — redirects to results page on success
- **On success**: `router.push("/results/{address}?jobId={jobId}")`
- **On failure**: Returns to State 1.2 with error message

#### State 1.5: Form Error

- **Trigger**: Invalid input or API error
- **Display**: Red `ShieldAlert` icon + error text below input
- **Error messages**:
  - Blank submit: "Enter a wallet address"
  - Invalid format: "Invalid Ethereum address"
  - API error: Server error message verbatim

### User Interactions

| Action | Result |
|--------|--------|
| Submit valid address | POST /api/analyze → redirect to /results/{address}?jobId={id} |
| Submit invalid address | Inline error (State 1.5) |
| Click leaderboard row | Navigate to /results/{address} (no jobId) |
| Click "Total Loss" header | Client-side re-sort by totalLossUsd |
| Click "Sandwiches" header | Client-side re-sort by txsSandwiched |
| Click time period button | Nothing (decorative) |
| Click "Leaderboard" nav | Smooth scroll to #leaderboard |

### Stats Section (Static)

Four hardcoded cards — not fetched from any API:
- "$2.4B total extracted"
- "4.2M wallets affected"
- "$571 avg gap"
- "12,847 sandwich attacks last 24h"

---

## Page 2: Results Dashboard (`app/results/[address]/page.tsx`)

### URL: `/results/{address}` or `/results/{address}?jobId={id}`

### Data Dependencies

| Source | Trigger | Frequency |
|--------|---------|-----------|
| `GET /api/status/{jobId}` | When `jobId` present + `isLoading` | Polled every 2,000ms |
| `GET /api/results/{address}` | When status becomes `"complete"` | Once |

### States

#### State 2.1: Loading / Polling (with jobId)

- **Trigger**: URL has `?jobId=` query param and status is not `complete`/`error`
- **Layout**: Full-page centered panel
- **Components**:
  - Red spinning `Loader2` in a rounded box
  - Current step label (from `STATUS_MESSAGES`)
  - Truncated wallet address + elapsed timer (MM:SS, counting up every 1s)
  - Animated progress bar (0-100%)
  - Progress label: `{processedTxs} / {totalTxs} txs`
  - 6-step checklist: green check (done), red spinner (active), grey dot (pending)
- **Actions**: Cancel button → navigate home

**Checklist steps (in order)** — maps to pipeline status keys:
1. Preparing analysis (`pending`)
2. Fetching transactions (30d) (`fetching_txs`)
3. Filtering out no-gap txs (`filtering`)
4. Querying mempool data (`querying_mempool`)
5. Simulating transactions (`simulating`)
6. Calculating losses (`calculating`)

#### State 2.2: Error

- **Trigger**: Job status becomes `"error"`
- **Layout**: Full-page centered panel
- **Components**: `AlertCircle` icon, "Analysis Failed" heading, error message text, "Try Again" button → home

#### State 2.3: No Results

- **Trigger**: `results` is null after loading completes (no error, no data)
- **Display**: Centered "No results found" text

#### State 2.4: Results Populated

- **Trigger**: Results fetched successfully from API
- **Layout**: Full dashboard (sections listed below)

**Section 1 — Wallet Header**:
- Gradient avatar circle (derived from first 2 hex chars of address)
- Truncated address (8 chars) with copy-to-clipboard button
- Rank badge + analysis timestamp

**Section 2 — Summary Cards (4-up grid)**:
| Card | Value | Style |
|------|-------|-------|
| Total Loss (30d) | `totalLossUsd` | Red border, gradient text |
| Annualized Loss | `totalLossUsd * 365/30` | — |
| Transactions Analyzed | `txsAnalyzed` | — |
| Sandwiched Transactions | `txsSandwiched` | Orange accent |

**Section 3 — Category Breakdown (3-up grid)**:
| Card | Value | Detail |
|------|-------|--------|
| Sandwich Attacks | `sandwichLossUsd` | + sandwich tx count |
| Price Drift | `delayLossUsd` | + avg delay in ms (if available) |
| Liquidity Drift | `slippageLossUsd` | — |

**Section 4 — Worst Transaction** (conditional — only if `worstTx` exists):
- Red border card
- Tx hash as Etherscan link (`https://etherscan.io/tx/{hash}`)
- Loss amount + gap type label

**Section 5 — Transactions Table** (max 15 rows via `.slice(0, 15)`):
| Column | Content |
|--------|---------|
| Hash | Etherscan link (opens new tab) |
| Token | Symbol from `tokenSymbol` |
| Type | Color-coded badge: red="sandwich", orange="delay", purple="slippage" |
| Loss | Negative USD value |

No "show more" control — remaining transactions are silently truncated.

**Section 6 — CTA Panel**:
- "Close Your Execution Gap" heading
- Link to `NEXT_PUBLIC_INTENTGUARD_URL` (falls back to `#`)

### User Interactions

| Action | Result |
|--------|--------|
| Copy address button | Copies full address to clipboard, green check for 2s |
| Click tx hash link | Opens Etherscan in new tab |
| Cancel button (loading) | Navigate home |
| Try Again button (error) | Navigate home |
| Back button / logo | Navigate home |
| "Enable Protection" CTA | External link to IntentGuard |

### No-jobId Navigation — RESOLVED

Two separate `useEffect` hooks handle the two navigation paths:
- **With `jobId`** (new analysis): polls `GET /api/status/{jobId}`, fetches results on completion
- **Without `jobId`** (leaderboard click): fetches `GET /api/results/{address}` directly, shows results or "No analysis found" error

---

## Page 3: Wall of Shame (`app/wall-of-shame/page.tsx`)

### URL: `/wall-of-shame`

### Data Dependencies

| Source | Trigger | Frequency |
|--------|---------|-----------|
| `GET /api/leaderboard?page={n}&limit=20` | On mount + page change | Per page navigation |

### States

#### State 3.1: Loading

- **Trigger**: On mount and every page change
- **Display**: 8 skeleton rows in table area

#### State 3.2: Error

- **Display**: Red-bordered card with `AlertCircle` and error message text
- **No retry button**

#### State 3.3: Empty

- **Trigger**: API returns 0 entries
- **Display**: `Activity` icon, "No wallets analyzed yet", "Analyze a Wallet" CTA → home

#### State 3.4: Populated (Page 1)

**Podium Section** (top 3 wallets only on page 1):
- Arranged as `[silver, gold, bronze]` = array indices `[1, 0, 2]`
- Staggered top-padding creates height difference (gold tallest)
- Each card: rank circle, truncated address (4 chars), total loss, sandwiched count
- Cards are clickable → `/results/{address}`

**Table Section**:
- All entries on this page, ranked
- Columns: Rank, Address (truncated), Total Loss (with CSS bar), Sandwiches
- Rows clickable → `/results/{address}`
- Sortable columns: "Total Loss" and "Sandwiches" (client-side re-sort only)

**Time period buttons**: 24h / 7d / 30d / All time — **decorative only** (same as landing page)

**Pagination**:
- Prev / Next buttons
- Disabled at boundaries (page 1 / last page)
- Page change triggers re-fetch

#### State 3.5: Populated (Page 2+)

- Same as State 3.4 but **without the podium section**
- Table + pagination only

### User Interactions

| Action | Result |
|--------|--------|
| Click podium card | Navigate to /results/{address} |
| Click table row | Navigate to /results/{address} |
| Click "Total Loss" header | Client-side re-sort |
| Click "Sandwiches" header | Client-side re-sort |
| Click time period button | Nothing (decorative) |
| Click Prev/Next | Fetch new page, show loading |
| Back / logo | Navigate to / |
| "Analyze Your Wallet" CTA | Navigate to / |

---

## Shared UI Patterns

### Leaderboard CSS Bar

Both landing page and wall-of-shame use the same visual pattern:
- A `div` beneath each total-loss figure
- Width: `(entry.totalLossUsd / maxLoss) * 100%`
- Background: red-orange gradient

### Slippage Column (Fabricated)

Both leaderboard views show a "Slippage" column computed as `totalLossUsd * 0.28`. The leaderboard API does not return a slippage breakdown — this is a **hardcoded placeholder multiplier**.

### Address Truncation

| Context | Format | Example |
|---------|--------|---------|
| Landing leaderboard | `truncateAddress()` | "0x1234...abcd" |
| Wall-of-shame podium | 4 chars | "0x12..." |
| Results header | 8 chars | "0x1234ab..." |

### Error Display

Consistent pattern across pages:
- Red `AlertCircle` or `ShieldAlert` icon
- Error message text
- Action button (Try Again, Analyze a Wallet, etc.)

---

## API Response → UI Mapping

### Results Page Data Flow

```
GET /api/results/{address}
    ↓
WalletAnalysisResult
    ├── totalLossUsd      → Summary card #1
    ├── annualizedLossUsd  → Summary card #2 (computed: totalLossUsd * 365/30)
    ├── txsAnalyzed        → Summary card #3
    ├── txsSandwiched      → Summary card #4
    ├── sandwichLossUsd    → Category card #1
    ├── delayLossUsd       → Category card #2
    ├── slippageLossUsd    → Category card #3
    ├── avgDelayMs         → Category card #2 detail
    ├── rank               → Header badge
    ├── analyzedAt         → Header timestamp
    ├── worstTx            → Worst tx card (conditional)
    └── transactions[0:15] → Table rows
```

### Leaderboard Data Flow

```
GET /api/leaderboard?page={n}&limit={m}
    ↓
LeaderboardResponse
    ├── entries[]
    │   ├── rank           → Row rank number
    │   ├── address        → Row click target
    │   ├── addressTruncated → Displayed address
    │   ├── totalLossUsd   → Loss column + CSS bar width
    │   └── txsSandwiched  → Sandwiches column
    ├── totalWallets       → Used for totalPages calculation
    ├── page               → Current page state
    └── totalPages         → Pagination boundary check
```

---

## Known Issues

| Issue | Location | Impact | Severity |
|-------|----------|--------|----------|
| Slippage column is fabricated (0.28 multiplier) | Both leaderboards | Misleading data | **Medium** — user sees inaccurate breakdown |
| "Last hit" column is fabricated (row-index-based) | Landing page leaderboard | Misleading data — shows fake recency | **Medium** — user sees fake timestamps |
| Time period buttons are decorative | Both leaderboards | Feature appears interactive but does nothing | **Low** — cosmetic |
| ENS input placeholder but no resolution | Landing page | User expects ENS to work | **Low** — misleading placeholder |
| Transactions capped at 15 with no "show more" | Results page | Users with many txs can't see full list | **Low** — data truncation |
| Stats section is hardcoded | Landing page | Numbers are static placeholders | **Low** — cosmetic |
