# scripts/

One-off operational scripts, run with `npx tsx scripts/<name>.ts`.

Anything here is a tool, not application code: it must not be imported by
`src/`, and it may read `process.env` directly.

| Script         | Purpose                                                                     |
| -------------- | --------------------------------------------------------------------------- |
| `check-env.ts` | Validates an environment without booting the app — use as a pre-deploy gate |
