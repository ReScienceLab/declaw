# Contributing to AWN (Agent World Network)

Thanks for your interest in contributing! AWN is an OpenClaw plugin for direct P2P communication between AI agent instances over plain HTTP/TCP.

## Getting Started

### Prerequisites

- Node.js 20+
- npm
- macOS or Linux

### Setup

```bash
git clone https://github.com/ReScienceLab/agent-world-network.git
cd agent-world-network
npm install
npm run build
node --test test/*.test.mjs
```

Tests import from `dist/` — always build before testing.

### Development

```bash
npm run dev          # watch mode (auto-rebuild on save)
npm run build        # one-time build
node --test test/*.test.mjs   # run all tests
```

## How to Contribute

### Reporting Bugs

- Search [existing issues](https://github.com/ReScienceLab/agent-world-network/issues) first
- Use the **Bug Report** issue template
- Include: steps to reproduce, expected vs actual behavior, OS and Node version

### Suggesting Features

- Use the **Feature Request** issue template
- Describe the use case and why it matters for P2P agent communication

### Good First Issues

Look for issues labeled [`good first issue`](https://github.com/ReScienceLab/agent-world-network/labels/good%20first%20issue) — these are scoped, well-described tasks ideal for newcomers.

### Submitting Code

1. Fork the repo and create a branch from `main`:
   ```bash
   git checkout main
   git checkout -b feature/your-feature
   ```

2. Make your changes, following the conventions below

3. Add a changeset describing what changed:
   ```bash
   npx changeset add
   ```

4. Build and test:
   ```bash
   npm run build
   node --test test/*.test.mjs
   ```

5. Push and create a PR targeting `main`:
   ```bash
   git push -u origin feature/your-feature
   gh pr create --base main
   ```

5. Wait for CI (Node 20+22 test matrix) to pass. All PRs are squash-merged.

## Coding Conventions

- **TypeScript**: strict mode, ES2022, no semicolons
- **Tests**: `node:test` + `node:assert/strict` (no external test frameworks)
- **Commit messages**: conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`)
- **No AI watermarks**: do not add AI-generated signatures to commits

### Branch Naming

- `feature/<slug>` — new features
- `fix/<slug>` — bug fixes
- `chore/<slug>` — maintenance

### What We Look For in PRs

- Tests for new functionality
- No regressions (all 151+ existing tests pass)
- Clear commit message explaining *why*, not just *what*
- No secrets, keys, or sensitive data

## Architecture Quick Reference

```
src/index.ts          → Plugin entry, service lifecycle, world membership tracking, tools
src/peer-server.ts    → Inbound HTTP (Fastify) with world co-membership enforcement
src/peer-client.ts    → Outbound signed messages
src/peer-db.ts        → JSON peer store with TOFU
src/identity.ts       → Ed25519 keypair, agentId derivation
src/address.ts        → Direct peer address parsing utilities
src/transport.ts      → Transport interface + TransportManager
src/transport-quic.ts → UDPTransport with ADVERTISE_ADDRESS endpoint config
src/channel.ts        → OpenClaw channel adapter
src/types.ts          → Shared interfaces
```

Trust model (4-layer): Ed25519 signature → TOFU key pinning → agentId binding → world co-membership.

## Questions?

Use [GitHub Discussions](https://github.com/ReScienceLab/agent-world-network/discussions) for questions, ideas, and general discussion. Issues are for bugs and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
