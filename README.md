# Proofline

Proofline is a research chat agent built with Node.js 22 and native SQLite where web search is the only model-visible tool, while memory recall and evidence verification stay in deterministic application code.

## Quickstart

Install dependencies, configure environment variables, and start the development server:

```bash
npm install
cp .env.example .env
npm run dev
```

The server starts at `http://127.0.0.1:3000` with session isolation and daily quotas enabled.

## Keys

Two API keys are required in `.env`:
- `GEMINI_API_KEY`: from Google AI Studio.
- `TAVILY_API_KEY`: from Tavily.

Free tier keys are sufficient for evaluation runs.

## Official Prompts

The three official challenge prompts are accessible as one-click starter buttons in the browser interface:
1. "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
2. "What did I ask you on 3 November? Is your answer still correct today?"
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

## Performance

Live performance benchmarks and stage latency breakdowns across the official prompts are recorded in [DESIGN.md](DESIGN.md#measured) and [live-latest.json](evals/results/live-latest.json).

## Offline Demo

Run `npm run demo` to start the scripted offline demo without API keys. The demo uses bundled mock responses to illustrate interface interaction and date recall, but does not provide evidence of live model behaviour.

## Deployment and Results

Proofline is hosted at [https://proofline-znhc.onrender.com](https://proofline-znhc.onrender.com). Because the free Render instance sleeps after inactivity, the initial cold request takes around one minute to wake up. Architecture decisions are detailed in [DESIGN.md](DESIGN.md).
