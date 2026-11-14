import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { trustLabel } from '../src/seeds/domains.mjs';
import PLANS from '../src/seeds/plans.json' with { type: 'json' };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const valueAfter = (flag) => { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; };
const group = valueAfter('--group') || 'offline';
const live = args.includes('--live');
const limitValue = Number(valueAfter('--limit'));
const limit = Number.isFinite(limitValue) && limitValue > 0 ? limitValue : Infinity;
const groups = {
  offline: ['tests/*.test.mjs'],
  dates: ['tests/time-memory.test.mjs'],
  evidence: ['tests/evidence.test.mjs'],
  comparison: ['tests/compare.test.mjs'],
  'search-input': ['tests/search-input.test.mjs'],
  replay: ['tests/replay.test.mjs'],
  server: ['tests/server.test.mjs'],
};
const runDate = new Date();
const runId = `offline-${runDate.toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`;
const report = {
  date: runDate.toISOString(), run_id: runId, model: config.geminiModel,
  group,
  provider_keys_present: {
    gemini: Boolean(config.geminiKey),
    tavily: Boolean(config.tavilyKey),
    grader: Boolean(config.graderKey && config.graderModel && config.graderBaseUrl),
  },
  live_calls_made: 0,
};

if (group === 'search-policy' && live) {
  try {
    const { runSearchPolicyLive } = await import('./live-search-policy.mjs');
    Object.assign(report, await runSearchPolicyLive(limit), { group, live: true });
  } catch (error) { report.status = 'not_run'; report.reason = error.message; }
} else if (group === 'general-research' && live) {
  try {
    const { runGeneralResearchLive } = await import('./general-research.mjs');
    Object.assign(report, await runGeneralResearchLive(limit), { group, live: true, status: 'completed' });
  } catch (error) { report.status = 'not_run'; report.reason = error.message; }
} else if (group === 'official-prompts' && live) {
  try {
    const { runOfficialPromptsLive } = await import('./official-prompts.mjs');
    Object.assign(report, await runOfficialPromptsLive(), { group, live: true, status: 'completed' });
  } catch (error) { report.status = 'not_run'; report.reason = error.message; }
} else if (['ablation', 'latency', 'failures', 'reviewer'].includes(group) && live) {
  report.status = 'not_run';
  report.reason = 'This group needs its dedicated multi-run live harness and configured provider keys. It is not measured by the offline suite.';
} else if (groups[group]) {
  const files = groups[group].includes('tests/*.test.mjs')
    ? fs.readdirSync(path.join(ROOT, 'tests')).filter((file) => file.endsWith('.test.mjs')).map((file) => path.join('tests', file))
    : groups[group].map((file) => path.join(ROOT, file));
  const result = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8' });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const match = output.match(/(?:#|ℹ)\s*tests\s+(\d+)[\s\S]*?(?:#|ℹ)\s*suites\s+(\d+)[\s\S]*?(?:#|ℹ)\s*pass\s+(\d+)[\s\S]*?(?:#|ℹ)\s*fail\s+(\d+)[\s\S]*?(?:#|ℹ)\s*cancelled\s+(\d+)[\s\S]*?(?:#|ℹ)\s*skipped\s+(\d+)/);
  if (!match) {
    process.stderr.write(`Failed to parse test runner summary from test output:\n${output.slice(-500)}\n`);
    process.exit(1);
  }
  report.test_summary = {
    tests: Number(match[1]), suites: Number(match[2]), pass: Number(match[3]),
    fail: Number(match[4]), cancelled: Number(match[5]), skipped: Number(match[6]),
  };
  report.status = result.status === 0 && report.test_summary.fail === 0 ? 'passed' : 'failed';
  report.command_exit_code = result.status;
  report.output_tail = output.split(/\r?\n/).slice(-35).join('\n');
  report.offline_provider_calls = {
    gemini: 0, tavily_search: 0, tavily_extract: 0,
    explanation: 'Offline tests use local fixtures and mocked fetch functions; no provider API request is made.',
  };
} else {
  report.status = 'not_run';
  report.reason = `Unknown or unavailable evaluation group: ${group}.`;
}

const resultsDir = path.join(ROOT, 'evals/results');
fs.mkdirSync(resultsDir, { recursive: true });
if (group === 'offline' && !live && report.status === 'passed' && report.test_summary) {
  const counts = readCaseCounts();
  const metrics = readDomainMetrics();
  report.case_matrix = counts;
  report.domain_fixture_metrics = metrics;
  writeLatestReport(report, resultsDir);
  writeResultsMarkdown(report, counts, metrics);
  updateReadme(report);
} else {
  fs.writeFileSync(path.join(resultsDir, 'latest.json'), `${JSON.stringify(report, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status === 'failed') process.exitCode = 1;

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

function readCaseCounts() {
  const dates = readJson('evals/cases/dates-recall.json').cases.length;
  const evidence = readJson('evals/cases/evidence.json').cases.length;
  const comparison = readJson('evals/cases/comparison.json').cases.length;
  const domain = readJson('evals/cases/domain-labels.json');
  const searchPolicy = readJson('evals/cases/search-policy.json').cases;
  const drafts = readJson('evals/cases/search-policy-drafts.json');
  const official = readJson('evals/cases/official-prompts.json');
  const general = readJson('evals/cases/general-research.json').prompts.length;
  const failures = readJson('evals/cases/failure-resilience.json').cases.length;
  const reviewer = readJson('evals/cases/reviewer.json').cases.length;
  const ablation = readJson('evals/cases/ablation.json').cases.length;
  return {
    dates_recall: dates,
    evidence: evidence,
    comparison: comparison,
    domain_labels: domain.seeded.length + domain.non_seeded.length + domain.lookalikes.length,
    domain_seeded_entities: domain.seeded.length,
    domain_non_seeded_entities: domain.non_seeded.length,
    domain_lookalikes: domain.lookalikes.length,
    search_policy: searchPolicy.length,
    search_policy_traps: searchPolicy.filter((item) => item.expected_search).length,
    search_policy_controls: searchPolicy.filter((item) => !item.expected_search).length,
    stable_scanner_regression_cases: drafts.stable_regression_cases.length,
    mutable_scanner_regression_cases: drafts.mutable_trap_regression_cases.length,
    official_prompts: official.prompts.length * official.history_modes.length,
    general_research: general,
    failure_resilience: failures,
    reviewer: reviewer,
    ablation: ablation,
  };
}

function readDomainMetrics() {
  const data = readJson('evals/cases/domain-labels.json');
  const seededMisses = data.seeded.filter((item) => trustLabel(item.entity, item.url, PLANS).label === 'Third party').length;
  const nonSeededMisses = data.non_seeded.filter((item) => trustLabel(item.entity, item.url, PLANS).label === 'Third party').length;
  const falseNameMatched = data.lookalikes.filter((item) => (
    trustLabel(item.entity, item.url, PLANS).label === 'Vendor site (not verified)'
  )).length;
  return {
    fixture_lists_authored_by_project: true,
    not_live_ownership_audit: true,
    seeded_entities: data.seeded.length,
    non_seeded_entities: data.non_seeded.length,
    lookalikes: data.lookalikes.length,
    seeded_false_third_party: seededMisses,
    seeded_false_third_party_rate: `${(100 * seededMisses / data.seeded.length).toFixed(1)}%`,
    non_seeded_false_third_party: nonSeededMisses,
    non_seeded_false_third_party_rate: `${(100 * nonSeededMisses / data.non_seeded.length).toFixed(1)}%`,
    false_name_match: falseNameMatched,
    false_name_match_rate: `${(100 * falseNameMatched / data.lookalikes.length).toFixed(1)}%`,
  };
}

function writeLatestReport(value, directory) {
  fs.writeFileSync(path.join(directory, 'latest.json'), `${JSON.stringify(value, null, 2)}\n`);
  for (const filename of fs.readdirSync(directory)) {
    if (/^run-.*\.json$/.test(filename)) fs.rmSync(path.join(directory, filename));
  }
}

function writeResultsMarkdown(value, counts, metrics) {
  const docsDir = path.join(ROOT, 'docs');
  if (!fs.existsSync(docsDir)) return;
  const date = value.date.slice(0, 10);
  const summary = value.test_summary;
  const table = [
    ['Dates and recall', `${counts.dates_recall}`, 'Date, failed-turn, import-date and recall regressions; matrix inventory size checked.', 'The 41 prompts are not all replayed as end-to-end conversations.'],
    ['Evidence and figures', `${counts.evidence}`, 'Quote validation, target/entity scoping, excerpt-only figure support, date and plan checks.', 'The 22-row matrix is an inventory; selected regressions are executable offline.'],
    ['Comparison', `${counts.comparison}`, 'Comparison rules and trust-label regression tests.', 'The 25-row matrix is not a complete live conversation run.'],
    ['Domain labels', `${counts.domain_labels} (${counts.domain_seeded_entities} seeded + ${counts.domain_non_seeded_entities} non-seeded + ${counts.domain_lookalikes} lookalikes)`, `Seeded false-third-party: ${metrics.seeded_false_third_party_rate}; non-seeded false-third-party: ${metrics.non_seeded_false_third_party_rate}; false name-match: ${metrics.false_name_match_rate}.`, 'Project-authored fixtures only; not a live ownership audit.'],
    ['Search policy', `${counts.search_policy} prompt cases (15 traps + 25 controls); ${counts.stable_scanner_regression_cases + counts.mutable_scanner_regression_cases} scanner regression cases (${counts.stable_scanner_regression_cases} stable + ${counts.mutable_scanner_regression_cases} mutable)`, 'All 65 project-authored scanner regression cases run offline. They test scanner consistency, not live-model behaviour; the prompt matrix is defined.', 'The live run of the 15 traps and 25 controls with a real model is UNMEASURED.'],
    ['Official prompts', `${counts.official_prompts} (3 prompts × 4 history modes)`, 'Prompt/history-mode matrix is defined; mock behaviour is covered by selected e2e tests.', 'All 12 combinations need a live run.'],
    ['General research', `${counts.general_research}`, 'Prompt inventory is defined.', 'Live Gemini/Tavily plus independent grader.'],
    ['Failure and resilience', `${counts.failure_resilience}`, 'Provider 429, abort, persistence isolation and per-entity failure regressions.', 'Live provider failures and remaining scenarios.'],
    ['Reviewer behaviour', `${counts.reviewer}`, 'Recall/date/no-recall, card ordering and figure-marker regressions cover key cases.', 'Full reviewer conversation runs.'],
    ['Ablation', `${counts.ablation}`, 'Replay retrieval-stability and natural-query coverage tests; A/B/C input builders share evidence.', 'Repeated A/B/C model runs and independent grading: NOT MEASURED.'],
    ['Extraction benchmark', '12 real pages', 'Not run.', 'Tavily/Gemini keys and hand-checked real pages.'],
    ['Latency', '20+ live turns per turn type', 'Instrumentation exists; no live latency run.', 'Live requests needed for median and p95.'],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');

  const costs = [
    ['Dates and recall (41)', '0–41', '0', '0'],
    ['Evidence (22)', '0–220', '0–308', '0–176'],
    ['Comparison (25)', '25–250', '0–350', '0–200'],
    [`Domain labels (${counts.domain_labels})`, '0', '0', '0'],
    ['Search policy (40)', '40–175', '0–210', '0–120'],
    ['Official prompts (12)', '12–120', '0–168', '0–96'],
    ['General research (15)', '15–150', '0–210', '0–120'],
    ['Failure and resilience (8)', '8–80', '0–112', '0–64'],
    ['Reviewer behaviour (9)', '9–90', '0–126', '0–72'],
    ['Ablation (6 cases × 3 arms)', '18–180', '0–84 shared retrieval', '0–48 shared retrieval'],
    ['12-page extraction benchmark', '0–12', '0', '12'],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');

  const markdown = `# Evaluation results\n\n` +
`Latest offline run: **${value.run_id}** (${date}); configured model: \`${value.model}\`.\n\n` +
`## Offline test result\n\n` +
`\`npm run eval\` completed with **${summary.tests} tests, ${summary.pass} passed, ${summary.fail} failed, ${summary.skipped} skipped**. It ran the local Node test suite and did not call Gemini, Tavily or the independent grader. The machine-readable report is \`evals/results/latest.json\`. This run is a local automated regression result, not evidence of live provider compatibility.\n\n` +
`The suite also includes syntax, repository convention and documentation checks when run through \`npm run check\`. The check command is the submission gate; the test count above is the Node test-runner count recorded by the eval command.\n\n` +
`The provider smoke command was attempted in this environment but did not run because \`GEMINI_API_KEY\` and \`TAVILY_API_KEY\` were absent. No live provider transcripts or official-prompt transcripts were produced; these remain UNVERIFIED/UNMEASURED.\n\n` +
`## Case matrix status\n\n` +
`All matrix files and planned case counts are built. The following table separates case definitions from the offline behaviours actually executed; it does not imply that every named prompt was run end-to-end.\n\n` +
`| Evaluation group | Case definitions | What was exercised offline | What remains |\n| --- | ---: | --- | --- |\n${table}\n\n` +
`## Offline domain fixture result\n\n` +
`The project-authored domain fixtures contain ${metrics.seeded_entities} seeded entities, ${metrics.non_seeded_entities} non-seeded entities and ${metrics.lookalikes} lookalikes. Seeded false-third-party rate: **${metrics.seeded_false_third_party_rate} (${metrics.seeded_false_third_party}/${metrics.seeded_entities})**. Non-seeded false-third-party rate: **${metrics.non_seeded_false_third_party_rate} (${metrics.non_seeded_false_third_party}/${metrics.non_seeded_entities})**. False name-match rate across all lookalikes: **${metrics.false_name_match_rate} (${metrics.false_name_match}/${metrics.lookalikes})**. Both domain lists are fixtures built by the project author, not a live ownership audit.\n\n` +
`## Estimated provider calls per full group run\n\n` +
`| Group | Gemini calls | Tavily Search calls | Tavily Extract calls |\n| --- | ---: | ---: | ---: |\n${costs}\n\n` +
`These are planning ranges, not observed use or USD prices. They use the application ceilings of 10 Gemini calls, 14 Tavily searches and 8 Tavily extracts per turn. Check-turn examples use seven Gemini calls for five targets with live history and eight with imported history; a turn never exceeds ten. Search/Extract upper bounds assume every relevant turn reaches the application cap; a known baseline URL is extracted directly and may reduce Search calls. The ablation rows assume shared evidence retrieval across its three arms. Provider credit costs and quotas remain **UNVERIFIED**. The independent grader key is evaluation-only and is not read by the chat agent; the planning grader allowance is 15 calls for general research and up to 18 for six three-arm ablation cases.\n\n` +
`## What is built, run and still unmeasured\n\n` +
`- **Built:** 41 date/recall, 22 evidence, 25 comparison, 97 domain-label (40 seeded, 30 non-seeded, 27 lookalikes), 40 search-policy prompt, 65 scanner regression (40 stable drafts and 25 mutable traps), 12 official-prompt, 15 general-research, 8 failure/resilience, 9 reviewer and 6 ablation case definitions.\n` +
`- **Run offline:** the full Node regression suite; all ${counts.domain_labels} domain-label fixtures; all 65 scanner regression cases; six ablation retrieval-coverage/stability cases; mocked failure and extraction paths exercised by named regression tests.\n` +
`- **Needs live keys:** the live evaluation runner is implemented and covered by an offline dry-run test, but has not yet been run against real providers; the 15 search-policy traps and 25 controls with a real model, all official prompts, general research, live provider failures, independent grader calibration, the 12-page extraction benchmark and repeated A/B/C ablation remain UNMEASURED. The real-model search-policy run remains **UNMEASURED**; live provider checks and Gemini/Tavily quotas remain **UNVERIFIED**.\n` +
`- **Not measured:** ablation outcomes, extraction success rate, latency median/p95, provider credit spend, and Windows/macOS compatibility.\n\n` +
`The replay backend is synthetic and cannot validate current vendor facts. No ablation result is claimed until the three arms are run repeatedly against identical evidence and independently graded.\n`;
  fs.writeFileSync(path.join(docsDir, 'results.md'), markdown);
}

function updateReadme(report) {
  const filename = path.join(ROOT, 'README.md');
  const current = fs.readFileSync(filename, 'utf8');
  if (!current.includes('<!-- LATEST_EVAL_START -->') || !current.includes('<!-- LATEST_EVAL_END -->')) {
    const testCount = report.test_summary?.tests;
    if (testCount !== undefined) {
      const updated = current.replace(/\|\s*Offline Suite \(`latest\.json`\)\s*\|\s*\d+\s+tests\s*\|\s*\d+\s*\|/, `| Offline Suite (\`latest.json\`) | ${testCount} tests | ${testCount} |`);
      if (updated !== current) {
        fs.writeFileSync(filename, updated);
      }
    }
    return;
  }
  const replacement = '<!-- LATEST_EVAL_START -->\n'
    + 'Evaluation metrics are recorded in machine-readable [evals/results/latest.json](evals/results/latest.json).\n'
    + '<!-- LATEST_EVAL_END -->';
  const next = current.replace(/<!-- LATEST_EVAL_START -->[\s\S]*?<!-- LATEST_EVAL_END -->/, replacement);
  fs.writeFileSync(filename, next);
}
