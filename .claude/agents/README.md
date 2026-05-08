# Agent Personas

This directory contains persona files for specialist agents. Each file defines an agent's role, scope, tools, constraints, and lessons learned.

## Usage

When spinning up a specialist agent in a new Claude Code tab, point it to its persona file:

```bash
claude -p "Read .claude/agents/testing.md and then [your task]"
```

Or start an interactive session and paste: "Read `.claude/agents/testing.md` — that's your role for this session."

## Agents

| File | Role | When to use |
|------|------|-------------|
| `dev.md` | Development | Default agent — implements features, follows blueprints |
| `testing.md` | Testing | Write tests, validate contracts, generate edge case inputs |
| `security.md` | Security | Audit API key handling, input validation, secret leakage |
| `review.md` | Code Review | Compare implementation against blueprints, flag deviations |

## Rules

1. **Specialist agents do NOT fix code.** They report findings.
2. **Only the dev agent modifies source files** in `app/` and `lib/`.
3. Specialist agents may create files in `tests/`, `reports/`, or their own output directories.
4. All agents read `CLAUDE.md` and the relevant blueprints before starting work.
