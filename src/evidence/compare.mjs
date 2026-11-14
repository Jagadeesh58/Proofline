import { trustLabel, registrableDomain } from '../seeds/domains.mjs';
import { USER_STRINGS, reportedSinceLabel } from '../strings.mjs';

function qualifiers(claim) {
  try { return [...JSON.parse(claim.qualifiers || '[]')].sort(); }
  catch { return []; }
}

function comparablePlanKey(value) {
  return String(value || '').toLowerCase().normalize('NFKC')
    .replace(/\b(?:plan|tier|edition|customer platform)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function plansMatch(left, right, aliases = {}) {
  const a = comparablePlanKey(left);
  const b = comparablePlanKey(right);
  if (!a || !b) return a === b;
  if (a === b) return true;
  if (aliases[a] && comparablePlanKey(aliases[a]) === b) return true;
  if (aliases[b] && comparablePlanKey(aliases[b]) === a) return true;
  return false;
}

function numericVersion(value) {
  const match = String(value || '').match(/\b\d+(?:\.\d+){1,3}\b/);
  if (!match) return null;
  return match[0].split('.').map(Number);
}

function compareVersion(current, baseline) {
  const a = numericVersion(current.value_text);
  const b = numericVersion(baseline.value_text);
  if (!a || !b || a.length !== b.length) return USER_STRINGS.cannotCompareTerms;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] > b[index]) return USER_STRINGS.changedNewerVersion;
    if (a[index] < b[index]) return USER_STRINGS.cannotCompareTerms;
  }
  return USER_STRINGS.sameAsBefore;
}

function coreTerms(claim) {
  if (claim.attribute === 'price') {
    return [
      claim.currency || 'unknown',
      claim.price_unit || 'unknown',
      claim.period || 'unknown',
      claim.commitment || 'unknown',
    ];
  }
  if (claim.attribute === 'limit') return [claim.unit || 'unknown', claim.period || 'unknown'];
  if (claim.attribute === 'version') {
    return [qualifiers(claim).find((item) => item.startsWith('channel:')) || 'unknown'];
  }
  return [];
}

function parsePageDate(text) {
  const months = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
  const dateRegex = new RegExp(
    `(\\d{4}-\\d{2}-\\d{2}|${months}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${months}\\s+\\d{4})`,
    'i'
  );
  const match = String(text || '').match(dateRegex);
  if (!match) return null;
  const dayFirst = match[1].match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  const parsed = dayFirst ? new Date(`${dayFirst[2]} ${dayFirst[1]}, ${dayFirst[3]}`) : new Date(match[1]);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function pageDateBeforeBaseline(source, baseline) {
  if (!source?.page_date_text) return false;
  const pageDate = parsePageDate(source.page_date_text);
  const baselineDate = new Date(baseline.observed_at_utc);
  return Boolean(pageDate && !Number.isNaN(baselineDate.getTime()) && pageDate < baselineDate);
}

function priceTerms(claim) {
  return [claim.currency || 'unknown', claim.price_unit || 'unknown', claim.period || 'unknown'];
}

function compareTerms(current, baseline) {
  const termsNow = current.attribute === 'price' ? priceTerms(current) : coreTerms(current);
  const termsBefore = baseline.attribute === 'price' ? priceTerms(baseline) : coreTerms(baseline);
  if (
    termsNow.some((term) => !term || term === 'unknown')
    || termsBefore.some((term) => !term || term === 'unknown')
  ) {
    return { ok: false, reason: 'terms_unknown' };
  }
  if (JSON.stringify(termsNow) !== JSON.stringify(termsBefore)) {
    return { ok: false, reason: 'terms_differ', differs: true };
  }
  let partlyUnknown = false;
  if (current.attribute === 'price') {
    if (current.currency === 'ambiguous_dollar' || baseline.currency === 'ambiguous_dollar') {
      partlyUnknown = true;
    }
    const nowCommitment = current.commitment || 'unknown';
    const beforeCommitment = baseline.commitment || 'unknown';
    if (nowCommitment === 'unknown' && beforeCommitment === 'unknown') {
      partlyUnknown = true;
    } else if (nowCommitment === 'unknown' || beforeCommitment === 'unknown') {
      return { ok: false, reason: 'terms_unknown', differs: true };
    } else if (nowCommitment !== beforeCommitment) {
      return { ok: false, reason: 'terms_differ', differs: true };
    }
  }
  if (JSON.stringify(qualifiers(current)) !== JSON.stringify(qualifiers(baseline))) {
    return { ok: false, reason: 'terms_differ', differs: true };
  }
  return { ok: true, partlyUnknown };
}

function sourceFor(store, claim) { return claim.source_id ? store.getSource(claim.source_id) : null; }

function verdict(current, baseline, store, plans = {}) {
  if (!baseline) return { status: USER_STRINGS.noEarlierRecord, reason: null };
  const currentSource = sourceFor(store, current);
  const baselineSource = sourceFor(store, baseline);
  const currentTrust = currentSource
    ? trustLabel(current.entity_key, currentSource.url, plans)
    : { label: USER_STRINGS.thirdParty };
  const baselineTrust = baselineSource
    ? trustLabel(baseline.entity_key, baselineSource.url, plans)
    : { label: USER_STRINGS.thirdParty };
  if (current.baseline_basis === 'answer_text' || baseline.baseline_basis === 'answer_text') {
    const terms = compareTerms(current, baseline);
    if (!terms.ok) {
      return {
        status: terms.differs ? USER_STRINGS.cannotCompareTerms : USER_STRINGS.couldntConfirm,
        reason: terms.reason,
      };
    }
    const equal = current.amount !== null && baseline.amount !== null
      ? current.amount === baseline.amount
      : current.value_text === baseline.value_text;
    const suffix = terms.partlyUnknown ? ' (billing terms not stated)' : '';
    const reason = terms.partlyUnknown
      ? 'terms_partly_unknown'
      : (equal ? null : 'earlier_answer_unverified');
    return {
      status: `${equal ? USER_STRINGS.sameAsEarlierAnswer : USER_STRINGS.differsFromEarlierAnswer}${suffix}`,
      reason,
    };
  }
  if (!currentSource || !baselineSource) return { status: USER_STRINGS.couldntConfirm, reason: 'third_party_source' };
  if (currentTrust.label === USER_STRINGS.thirdParty || baselineTrust.label === USER_STRINGS.thirdParty) {
    return { status: USER_STRINGS.couldntConfirm, reason: 'third_party_source' };
  }
  const sameDomain = registrableDomain(currentSource.url) === registrableDomain(baselineSource.url);
  if (!sameDomain && !(currentTrust.verified && baselineTrust.verified)) {
    return { status: USER_STRINGS.couldntConfirm, reason: 'different_source_sites' };
  }
  if (pageDateBeforeBaseline(currentSource, baseline)) {
    return { status: USER_STRINGS.couldntConfirm, reason: 'stale_page' };
  }
  const terms = compareTerms(current, baseline);
  if (!terms.ok) {
    return {
      status: terms.differs ? USER_STRINGS.cannotCompareTerms : USER_STRINGS.couldntConfirm,
      reason: terms.reason,
    };
  }
  if (current.attribute === 'version') return { status: compareVersion(current, baseline), reason: null };
  const equal = current.amount !== null && baseline.amount !== null
    ? current.amount === baseline.amount
    : current.value_text === baseline.value_text;
  const suffix = terms.partlyUnknown ? ' (billing terms not stated)' : '';
  return {
    status: `${equal ? USER_STRINGS.sameAsBefore : USER_STRINGS.changed}${suffix}`,
    reason: terms.partlyUnknown ? 'terms_partly_unknown' : null,
  };
}

/** Assigns every comparison status in code before the model writes commentary. */
export function buildComparisonCards({
  store,
  targets,
  currentClaims,
  baselineClaims,
  sinceByEntity = {},
  plans = {},
}) {
  return targets.map((target) => {
    const targetKey = target.entity_key;
    const stripped = String(targetKey || '')
      .replace(/\b(crm|database|hosting|cloud|platform|app|software|suite)\b/gi, '')
      .trim();
    const firstWord = String(targetKey || '').split(' ')[0];
    const candidateKeys = [targetKey, stripped, firstWord].filter(Boolean);

    const currentForEntity = currentClaims.filter((claim) => (
      candidateKeys.includes(claim.entity_key)
      && target.checks.some((check) => (
        check === claim.attribute || (check === 'pricing' && claim.attribute === 'price')
      ))
    ));
    const page = target.page;
    const baselineForEntity = baselineClaims.filter((claim) => candidateKeys.includes(claim.entity_key));
    const cards = [];
    const attributes = target.checks.includes('pricing') ? ['price'] : [];
    if (target.checks.includes('limit')) attributes.push('limit');
    if (target.checks.includes('version')) attributes.push('version');
    for (const attribute of attributes) {
      const currentClaimsForAttribute = currentForEntity.filter((claim) => claim.attribute === attribute);
      if (!page && !currentClaimsForAttribute.length) {
        cards.push({
          entity: target.entity,
          attribute,
          status: USER_STRINGS.couldntConfirm,
          reason: 'no_results',
          domain: null,
        });
        continue;
      }
      if (!currentClaimsForAttribute.length) {
        cards.push({
          entity: target.entity,
          attribute,
          status: USER_STRINGS.couldntConfirm,
          reason: page?.extraction_reason || 'extraction_failed',
          domain: page?.domain || null,
        });
        continue;
      }
      for (const current of currentClaimsForAttribute) {
        const baseline = baselineForEntity.find((claim) => (
          claim.attribute === attribute && plansMatch(claim.plan_key, current.plan_key)
        )) || null;
        const result = verdict(current, baseline, store, plans);
        const currentSource = sourceFor(store, current);
        const trust = currentSource
          ? trustLabel(target.entity, currentSource.url, plans)
          : { label: USER_STRINGS.thirdParty };
        const unverifiedChange = [USER_STRINGS.changed, USER_STRINGS.sameAsBefore, USER_STRINGS.changedNewerVersion]
          .some((status) => result.status === status || result.status.startsWith(`${status} (`));
        const label = trust.label === USER_STRINGS.nameMatchedDomainNotVerified && unverifiedChange
          ? `${result.status} (site not verified)` : result.status;
        const delta = baseline && current.amount !== null && baseline.amount !== null
          ? Math.abs(current.amount - baseline.amount) : null;
        cards.push({
          entity: target.entity,
          attribute,
          plan: current.plan_key,
          status: label,
          reason: result.reason,
          domain: currentSource?.registrable_domain || page?.domain || null,
          trust_label: trust.label,
          current: {
            value: current.value_text,
            amount: current.amount,
            currency: current.currency,
            quote: current.evidence_quote,
            source_id: current.source_id,
          },
          baseline: baseline ? {
            value: baseline.value_text,
            amount: baseline.amount,
            currency: baseline.currency,
            quote: baseline.evidence_quote,
            source_id: baseline.source_id,
            observed_at_utc: baseline.observed_at_utc,
            basis: baseline.baseline_basis,
          } : null,
          delta_amount: result.status.startsWith(USER_STRINGS.changed) ? delta : null,
          source_url: currentSource?.url || null,
        });
      }
    }
    const since = sinceByEntity[target.entity_key] || target.since;
    const reported = currentClaims
      .filter((claim) => claim.entity_key === target.entity_key && claim.attribute === 'release')
      .map((claim) => ({ claim, source: sourceFor(store, claim) }))
      .filter(({ source }) => source?.provider_date && since && source.provider_date.slice(0, 10) >= since)
      .map(({ claim, source }) => ({
        date: source.provider_date,
        title: source.title,
        source_id: source.id,
        quote: claim.evidence_quote,
      }));
    return {
      entity: target.entity,
      entity_key: target.entity_key,
      cards,
      reported_since: since || null,
      reported_since_label: reportedSinceLabel(since),
      reported,
    };
  });
}
