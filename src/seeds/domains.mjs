import { USER_STRINGS } from '../strings.mjs';

export const OFFICIAL_DOMAIN_SEEDS = {
  github: { domains: ['github.com'], labels: ['github'], verifiedAt: '2026-11-12' },
  hubspot: { domains: ['hubspot.com'], labels: ['hubspot'], verifiedAt: '2026-11-12' },
  pipedrive: { domains: ['pipedrive.com'], labels: ['pipedrive'], verifiedAt: '2026-11-12' },
  zoho: { domains: ['zoho.com'], labels: ['zoho'], verifiedAt: '2026-11-12' },
  neon: { domains: ['neon.tech', 'neon.com'], labels: ['neon'], verifiedAt: '2026-11-13' },
  supabase: { domains: ['supabase.com'], labels: ['supabase'], verifiedAt: '2026-11-12' },
  vercel: { domains: ['vercel.com'], labels: ['vercel'], verifiedAt: '2026-11-12' },
  'aws rds': { domains: ['aws.amazon.com'], labels: ['aws'], verifiedAt: '2026-11-12' },
  notion: { domains: ['notion.so', 'notion.com'], labels: ['notion'], verifiedAt: '2026-11-13' },
  slack: { domains: ['slack.com'], labels: ['slack'], verifiedAt: '2026-11-12' },
  atlassian: { domains: ['atlassian.com'], labels: ['atlassian'], verifiedAt: '2026-11-12' },
  microsoft: { domains: ['microsoft.com'], labels: ['microsoft'], verifiedAt: '2026-11-12' },
  linear: { domains: ['linear.app'], labels: ['linear'], verifiedAt: '2026-11-12' },
  postgresql: { domains: ['postgresql.org'], labels: ['postgresql'], verifiedAt: '2026-11-12' },
  freshsales: { domains: ['freshworks.com'], labels: ['freshsales', 'freshworks'], verifiedAt: '2026-11-12' },
  monday: { domains: ['monday.com'], labels: ['monday'], verifiedAt: '2026-11-13' },
  salesforce: { domains: ['salesforce.com'], labels: ['salesforce'], verifiedAt: '2026-11-13' },
  'less annoying crm': { domains: ['lessannoyingcrm.com'], labels: ['lessannoyingcrm'], verifiedAt: '2026-11-13' },
  'microsoft dynamics': { domains: ['microsoft.com'], labels: ['microsoft'], verifiedAt: '2026-11-13' },
  'salesforce sales cloud': { domains: ['salesforce.com'], labels: ['salesforce'], verifiedAt: '2026-11-13' },
  mysql: { domains: ['mysql.com'], labels: ['mysql'], verifiedAt: '2026-11-13' },
  mongodb: { domains: ['mongodb.com'], labels: ['mongodb'], verifiedAt: '2026-11-13' },
  redis: { domains: ['redis.io'], labels: ['redis'], verifiedAt: '2026-11-13' },
  cockroachdb: { domains: ['cockroachlabs.com'], labels: ['cockroachdb'], verifiedAt: '2026-11-13' },
  planetscale: { domains: ['planetscale.com'], labels: ['planetscale'], verifiedAt: '2026-11-13' },
  aws: { domains: ['aws.amazon.com'], labels: ['aws', 'amazon'], verifiedAt: '2026-11-13' },
  azure: { domains: ['microsoft.com'], labels: ['azure', 'microsoft'], verifiedAt: '2026-11-13' },
  'google cloud': { domains: ['google.com'], labels: ['google', 'googlecloud'], verifiedAt: '2026-11-13' },
  digitalocean: { domains: ['digitalocean.com'], labels: ['digitalocean'], verifiedAt: '2026-11-13' },
  render: { domains: ['render.com'], labels: ['render'], verifiedAt: '2026-11-13' },
  railway: { domains: ['railway.app'], labels: ['railway'], verifiedAt: '2026-11-13' },
  cloudflare: { domains: ['cloudflare.com'], labels: ['cloudflare'], verifiedAt: '2026-11-13' },
  gitlab: { domains: ['gitlab.com'], labels: ['gitlab'], verifiedAt: '2026-11-13' },
  bitbucket: { domains: ['bitbucket.org'], labels: ['bitbucket'], verifiedAt: '2026-11-13' },
  netlify: { domains: ['netlify.com'], labels: ['netlify'], verifiedAt: '2026-11-13' },
  atlassian: { domains: ['atlassian.com'], labels: ['atlassian'], verifiedAt: '2026-11-13' },
  'microsoft 365': { domains: ['microsoft.com'], labels: ['microsoft'], verifiedAt: '2026-11-13' },
  'google workspace': { domains: ['google.com'], labels: ['google'], verifiedAt: '2026-11-13' },
  figma: { domains: ['figma.com'], labels: ['figma'], verifiedAt: '2026-11-13' },
  canva: { domains: ['canva.com'], labels: ['canva'], verifiedAt: '2026-11-13' },
  zoom: { domains: ['zoom.us'], labels: ['zoom'], verifiedAt: '2026-11-13' },
  discord: { domains: ['discord.com'], labels: ['discord'], verifiedAt: '2026-11-13' },
  spotify: { domains: ['spotify.com'], labels: ['spotify'], verifiedAt: '2026-11-13' },
  trello: { domains: ['trello.com'], labels: ['trello'], verifiedAt: '2026-11-13' },
};

const PRODUCT_PARENT_ALIASES = new Map([
  ['jira', ['atlassian']],
  ['confluence', ['atlassian']],
  ['trello', ['atlassian']],
  ['bitbucket', ['atlassian']],
  ['dynamics 365', ['microsoft']],
  ['microsoft dynamics', ['microsoft']],
  ['sales cloud', ['salesforce']],
  ['google workspace', ['google']],
  ['microsoft 365', ['microsoft']],
  ['aws rds', ['aws']],
  ['amazon rds', ['aws']],
]);

export const AGGREGATOR_BLOCKLIST = new Set([
  'g2.com', 'capterra.com', 'getapp.com', 'trustradius.com', 'producthunt.com',
  'techradar.com', 'forbes.com', 'reddit.com', 'medium.com', 'wikipedia.org',
  'crunchbase.com', 'softwareadvice.com', 'trustpilot.com', 'youtube.com',
  'startups.co.uk', 'tech.co', 'businessnewsdaily.com', 'business.com',
  'crmbuyer.com', 'cynoteck.com', 'selfhost.dev', 'metacto.com',
  'jetadmin.io', 'uibakery.io', 'makerkit.dev',
]);

// Known impersonation/lookalike domains stay third party even when their first label matches a seeded brand.
export const NAME_MATCH_DOMAIN_BLOCKLIST = new Set([
  'hubspot.in', 'hubspot.co', 'hubspot.org', 'hubspot.tech', 'hubspot.info',
  'pipedrive-crm.com', 'pipedrive-pricing-explained.com',
]);

export const ALLOWED_TLDS = new Set([
  'com', 'io', 'co', 'ai', 'app', 'dev', 'net', 'org', 'cloud',
]);

export function normaliseEntity(value) {
  return String(value || '').toLowerCase().normalize('NFKC').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

export function registrableDomain(input) {
  try {
    const host = new URL(input).hostname.toLowerCase().replace(/^www\./, '');
    const labels = host.split('.').filter(Boolean);
    if (labels.length <= 2) return host;
    const twoPart = new Set([
      'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au',
      'co.in', 'com.in', 'net.in', 'org.in', 'co.jp', 'com.br', 'com.sg',
    ]);
    const suffix = labels.slice(-2).join('.');
    return twoPart.has(suffix) && labels.length >= 3 ? labels.slice(-3).join('.') : labels.slice(-2).join('.');
  } catch { return 'unknown'; }
}

function candidateLabels(entity, planLabels = []) {
  const rawName = String(entity || '').trim();
  const original = normaliseEntity(rawName);
  const candidates = new Set();
  const add = (value) => {
    const normal = normaliseEntity(value).replaceAll(' ', '');
    if (normal.length >= 3) candidates.add(normal);
  };
  add(rawName);
  add(rawName.replace(/\.[a-z]{2,}$/i, ''));
  add(original);
  if (original.includes(' for ')) add(original.split(' for ')[0]);
  const categories = new Set([
    'crm', 'postgres', 'postgresql', 'mysql', 'db', 'database', 'cloud', 'hq',
    'app', 'software', 'hosting', 'workspace', 'suite', 'platform',
  ]);
  const words = original.split(' ').filter(Boolean);
  let start = 0;
  let end = words.length;
  while (start < end && categories.has(words[start])) start += 1;
  while (end > start && categories.has(words[end - 1])) end -= 1;
  add(words.slice(start, end).join(' '));
  const techVendors = ['microsoft', 'salesforce', 'amazon', 'google', 'oracle', 'ibm', 'adobe', 'aws', 'atlassian'];
  if (words.length > 1 && techVendors.includes(words[0])) add(words[0]);
  for (const label of planLabels) add(label);
  for (const [alias, parents] of PRODUCT_PARENT_ALIASES) {
    if (normaliseEntity(alias) === original) {
      for (const parent of parents) add(parent);
    }
  }
  return candidates;
}

export function entityMatchCandidates(entity, plans = {}) {
  const key = normaliseEntity(entity);
  return candidateLabels(entity, plans[key]?.domain_labels || []);
}

export function trustLabel(entity, url, plans = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { label: USER_STRINGS.thirdParty, verified: false, domain: 'unknown' };
  }
  const domain = registrableDomain(url);
  if (domain === 'unknown' || NAME_MATCH_DOMAIN_BLOCKLIST.has(domain)) {
    return { label: USER_STRINGS.thirdParty, verified: false, domain };
  }

  const entityKey = normaliseEntity(entity);
  const planConfig = plans[entityKey] || {};
  const entityCandidates = entityMatchCandidates(entity, plans);
  const matchingSeeds = Object.entries(OFFICIAL_DOMAIN_SEEDS).filter(([key, entry]) => (
    entityCandidates.has(normaliseEntity(key).replaceAll(' ', ''))
      || entry.labels.some((label) => entityCandidates.has(normaliseEntity(label).replaceAll(' ', '')))
  ));
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const seededDomain = matchingSeeds.find(([, entry]) => (
    entry.domains.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))
  ));
  if (seededDomain) {
    return {
      label: USER_STRINGS.officialSiteVerified,
      verified: true,
      domain,
      verifiedAt: seededDomain[1].verifiedAt,
    };
  }

  const main = domain.split('.')[0];
  const tld = host.split('.').at(-1);
  const perEntityTlds = new Set(
    (planConfig.allowed_tlds || []).map((value) => String(value).toLowerCase().replace(/^\./, ''))
  );
  const acceptedTld = perEntityTlds.has(tld) || ALLOWED_TLDS.has(tld);
  if (entityCandidates.has(main) && acceptedTld) {
    return { label: USER_STRINGS.nameMatchedDomainNotVerified, verified: false, domain };
  }
  return { label: USER_STRINGS.thirdParty, verified: false, domain };
}

export function isAggregator(url) {
  const domain = registrableDomain(url);
  return [...AGGREGATOR_BLOCKLIST].some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}
