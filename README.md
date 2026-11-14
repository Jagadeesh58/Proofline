# Proofline

Proofline is an evidence-first research chat agent built with Node.js 22 and native SQLite (`node:sqlite`). The language model has access to exactly one tool: `web_search`. Time arithmetic, historical recall, factual extraction, citation validation, and structured comparison cards remain entirely in deterministic application code.

## Quickstart

Requires Node.js 22.16.0 or later. There are zero runtime npm dependencies.

1. Copy `.env.example` to `.env` and set `GEMINI_API_KEY` and `TAVILY_API_KEY`.
2. Start the local server: `npm run dev`
3. Open `http://127.0.0.1:3000` in your browser.

To run offline verification: `npm run check`

## Live Deployment

Proofline is deployed at [https://proofline.onrender.com](https://proofline.onrender.com).

A container specification (`Dockerfile`) and blueprint (`render.yaml`) are included for single-container deployment. Run `node src/main.mjs` with `HOST=0.0.0.0` and `PORT=3000`.

## How It Works

Proofline stores conversational turns, retrieved pages, and factual claims in native SQLite using WAL mode. The application resolves relative date expressions ("last Tuesday", "on Monday"), ranks relevant past turns via BM25, and evaluates search policy to answer stable queries directly. When web search executes, pages are parsed into quote-backed claims and compared against historical baselines on identical domains. See [DESIGN.md](DESIGN.md) for architecture, request lifecycle, and honest operational limits.

## Evaluation Summary

All figures reflect executed runs recorded in `evals/results/`.

| Evaluation Suite | Questions | Passed | Median TTFT | Median Total | Faithfulness |
| --- | ---: | ---: | ---: | ---: | ---: |
| Offline Suite (`latest.json`) | 232 tests | 232 | N/A | N/A | N/A |
| Live Run (`live-latest.json`) | 3 | 3 | 32,925 ms | 33,029 ms | 85% |
