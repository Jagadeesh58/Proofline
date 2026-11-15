import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/memory/store.mjs';
import { validatePageClaims } from '../src/evidence/claims.mjs';
import { buildComparisonCards } from '../src/evidence/compare.mjs';

const frozenPages = JSON.parse(
  fs.readFileSync(path.resolve('evals/ground-truth/pricing-pages.json'), 'utf8')
);

test('frozen ground truth pricing facts evaluate to expected verdicts', () => {
  const store = new Store(':memory:');
  const baselineTurn = store.importTurn({
    user_text: 'What are database and CRM prices?',
    assistant_text: 'Baseline pricing from earlier turn.',
    created_at: '2026-11-01T10:00:00Z',
    source_created_at: '2026-11-01T10:00:00Z',
  });

  const currentTurn = store.createTurn({
    userText: 'Check current pricing against baseline.',
    timezone: 'Asia/Kolkata',
  });

  for (const fixture of frozenPages) {
    // Add baseline source and claim
    const baselineSource = store.addSource({
      turnId: baselineTurn.id,
      url: fixture.url,
      domain: fixture.entity_key + '.com',
      title: `${fixture.entity} Pricing Baseline`,
      pageText: fixture.page_text,
      retrievalKind: 'page_text',
      retrievedAt: '2026-11-01T10:00:00Z',
    });

    const validatedBaseline = validatePageClaims({
      store,
      turnId: baselineTurn.id,
      sourceItems: [{ source: baselineSource, entity: fixture.entity }],
      rawClaims: [{
        source_id: baselineSource.id,
        entity: fixture.entity,
        attribute: 'price',
        plan_name: fixture.expected_plan,
        value_text: fixture.expected_plan === 'Essential'
          ? `$${fixture.expected_amount} per user per month`
          : `$${fixture.expected_amount} per month`,
        amount: fixture.expected_amount,
        currency: fixture.expected_currency,
        price_unit: fixture.expected_plan === 'Essential' ? 'per_seat' : 'flat',
        unit: 'month',
        period: 'month',
        commitment: 'unknown',
        evidence_quote: fixture.page_text,
      }],
    });
    const baselineClaim = validatedBaseline.claims[0];

    // Add fresh retrieved source matching frozen page text
    const currentSource = store.addSource({
      turnId: currentTurn.id,
      url: fixture.url,
      domain: fixture.entity_key + '.com',
      title: `${fixture.entity} Current Pricing`,
      pageText: fixture.page_text,
      retrievalKind: 'page_text',
      retrievedAt: fixture.capture_date + 'T12:00:00Z',
    });

    const validated = validatePageClaims({
      store,
      turnId: currentTurn.id,
      sourceItems: [{ source: currentSource, entity: fixture.entity }],
      rawClaims: [{
        source_id: currentSource.id,
        entity: fixture.entity,
        attribute: 'price',
        plan_name: fixture.expected_plan,
        value_text: fixture.expected_plan === 'Essential'
          ? `$${fixture.expected_amount} per user per month`
          : `$${fixture.expected_amount} per month`,
        amount: fixture.expected_amount,
        currency: fixture.expected_currency,
        price_unit: fixture.expected_plan === 'Essential' ? 'per_seat' : 'flat',
        unit: 'month',
        period: 'month',
        commitment: 'unknown',
        evidence_quote: fixture.page_text,
      }],
    });

    assert.equal(validated.claims.length, 1, `Claim for ${fixture.entity} should be validated`);

    const cards = buildComparisonCards({
      store,
      targets: [{
        entity: fixture.entity,
        entity_key: fixture.entity_key,
        checks: ['pricing'],
        page: { domain: fixture.entity_key + '.com', source_id: currentSource.id },
      }],
      currentClaims: validated.claims,
      baselineClaims: [baselineClaim],
    });

    assert.equal(cards.length, 1);
    assert.match(cards[0].cards[0].status, /^Same as before/);
  }

  store.close();
});
