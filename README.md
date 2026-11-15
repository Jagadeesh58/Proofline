# Proofline

Proofline is a research chat agent built with Node.js 22 and SQLite where web search is the only model-visible tool, while memory recall and evidence verification stay in code.

## Quickstart

Run the following commands to install dependencies, configure environment variables, and start the development server:

```bash
npm install
cp .env.example .env
npm run dev
```

## Keys

Configure two API keys in `.env`:
- `GEMINI_API_KEY`: obtain from [Google AI Studio](https://aistudio.google.com).
- `TAVILY_API_KEY`: obtain from [Tavily](https://tavily.com).

## Official Prompts

The three official challenge prompts are accessible as one-click starter buttons in the browser interface:
1. "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"
2. "What did I ask you on 3 November? Is your answer still correct today?"
3. "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

## Performance

Measured live on the Gemini free tier:

| Prompt | Time to first token | Total latency | Full transcript |
| :--- | ---: | ---: | :--- |
| CRM check | 21.5 s | 26.9 s | [official-1.md](evals/transcripts/official-1.md) |
| 3 November recall | 18.0 s | 18.4 s | [official-2.md](evals/transcripts/official-2.md) |
| Postgres check | 26.9 s | 27.1 s | [official-3.md](evals/transcripts/official-3.md) |

## Offline Demo

Run `npm run demo` to start the scripted offline demo without API keys, where no AI model and no web search are used.

## Deployment and Results

Proofline is hosted at [https://proofline-znhc.onrender.com](https://proofline-znhc.onrender.com). Because the free Render instance sleeps after inactivity, the initial cold request can take around a minute to wake up.

Complete evaluation metrics and per-stage latency breakdowns are recorded in [live-latest.json](evals/results/live-latest.json). Architecture and verification decisions are detailed in [DESIGN.md](DESIGN.md).
