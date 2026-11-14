# Proofline

[![CI](https://github.com/Jagadeesh58/Proofline/actions/workflows/ci.yml/badge.svg)](https://github.com/Jagadeesh58/Proofline/actions/workflows/ci.yml)

Proofline is a research chat agent built with Node.js 22 and native SQLite (`node:sqlite`). The language model has access to exactly one tool: `web_search`, while temporal reasoning, historical recall, factual extraction, and comparison cards stay in application code.

## Quickstart

Requires Node.js 22.16.0 or later with zero runtime npm dependencies.

To run the full interface and official prompts immediately without API keys:

```bash
npm install
npm run demo
```

Open `http://127.0.0.1:3000` to interact with the recorded search corpus and live pipeline.

## Live Deployment

The service is deployed at [https://proofline.onrender.com](https://proofline.onrender.com). Because the free Render instance sleeps after inactivity, the first request after idle can take about a minute on the free host.

To run locally with live provider keys:

1. Copy `.env.example` to `.env` and configure `GEMINI_API_KEY` and `TAVILY_API_KEY`.
2. Start the application: `npm run dev`

## Official Prompts

The system is evaluated against the three hiring challenge prompts:

1. "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
2. "What did I ask you on 3 November? Is your answer still correct today?"
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

## Evaluation

- `npm run demo`: keyless local demonstration.
- `npm test`: runs the offline test suite.
- `npm run check`: runs syntax, linting, formatting, document verification, and multi-date simulations.
- `npm run eval`: executes offline evaluation fixtures.
- `npm run eval:live`: runs the live evaluation questions.
- `npm run eval:live:quick`: runs the three official prompts live.

## Repository Layout

- `src/`: core server, search orchestration, temporal resolver, and claim comparison.
- `evals/`: evaluation cases, replay corpus, and benchmark results.
- `tests/`: offline test suite.

For architectural decisions, request flow, and benchmark results, see [DESIGN.md](DESIGN.md).
