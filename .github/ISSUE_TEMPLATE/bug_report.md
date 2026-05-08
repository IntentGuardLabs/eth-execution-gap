---
name: Bug report
about: A number looks wrong, the CLI crashes, or upstream API handling misbehaves.
labels: bug
---

## What happened

<!-- One or two sentences. -->

## Reproduction

Command (with `--debug` if applicable):

```bash
npm run tx:run -- --tx 0x... --debug
```

Inputs (only the ones relevant — tx hash, wallet address, protocol):

- Tx hash:
- Wallet address:
- Protocol / window:

## Output

First ~30 lines of stdout, including any `[debug:*]` and WARN lines:

```
<paste here>
```

If the report file at `reports/<command>-runs/<...>.json` is small, attach or paste the relevant portion (gap fields, simulationStatus, expectedSimBlock).

## Environment

- OS:
- Node version (`node -v`):
- Commit (`git rev-parse HEAD`):
- Did the bug reproduce after `rm -rf .cache/`? Yes / No

## Expected vs actual

What did you expect, and what happened instead?
