# Security Policy

## Scope

This is a read-only analysis tool. It:

- **Never** signs transactions, prompts for a private key, or modifies on-chain state.
- Reads transaction data from public RPC sources via Etherscan, Dune, Tenderly, and DeFiLlama.
- Stores cached responses on the local filesystem under `.cache/`.
- Writes per-run reports to the local filesystem under `reports/`.

The only sensitive material it touches is the API keys in `.env` — these grant read-only access to the corresponding services and are never transmitted to any third party other than those services.

## Reporting a vulnerability

If you find a security issue — RCE, prototype pollution, an injection through a tx hash or wallet address, an unintended write outside `.cache/` or `reports/`, leaked credentials, or anything else that compromises a user running the CLI — please **do not open a public GitHub issue**.



Include:
- A description of the issue and its impact.
- Reproduction steps (commands, inputs, expected vs. actual behavior).
- The version (`git rev-parse HEAD` of the affected checkout).

We will acknowledge within 5 business days and aim to publish a fix or mitigation within 30 days. Please give us reasonable time to address the issue before public disclosure.

## Out of scope

These are not in scope for this policy:

- Bugs in the upstream services (Etherscan, Dune, Tenderly, DeFiLlama) — report those to the relevant vendor.
- Inaccurate gap calculations or misinterpreted simulation results — those are correctness issues, please open a normal GitHub issue with the reproduction tx hash.
- Rate-limit or quota exhaustion against the upstream services.
- Anything that requires the attacker to already have local code execution on the machine running the CLI.

## Supported versions

Only the latest commit on `main` is supported. There are no LTS branches.
