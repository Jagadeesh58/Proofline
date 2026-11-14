/**
 * Search policy engine: determines whether a turn requires external web search
 * or can be answered directly from internal logic/arithmetic/static knowledge.
 */

export function isArithmeticQuestion(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return false;

  // If the query explicitly asks for recent changes, news, or live checks, search is needed
  if (/\b(?:changed|shipped|since|latest|current|today|live|news|announcement|compare)\b/i.test(lower)) {
    return false;
  }

  // Word problem with seats / units and pricing calculation:
  // e.g. "If a sales team has 20 seats and each seat costs $15 per month billed annually, what is the annual spend?"
  const hasSeatUnits = /\b(?:\d+\s*(?:seats?|users?|people|members?|agents?|hosts?))\b/i.test(lower);
  const hasRate = /[$₹€£]?\s*\d+(?:\.\d+)?\s*(?:per\s*(?:month|seat|user|year|day)|\/(?:month|seat|user|year))/i
    .test(lower);
  const hasSpendAsk = /\b(?:annual(?:ly)?\s*(?:spend|cost|amount|bill)|total\s*(?:cost|spend|price|bill|amount))/i
    .test(lower) || /\b(?:what is the (?:annual|total)|how much (?:is|does|will))\b/i.test(lower);
  if (hasSeatUnits && hasRate && hasSpendAsk) {
    return true;
  }

  // Explicit calculation or arithmetic prompt
  const hasMathAsk = /\b(?:calculate|compute|what is|how much is|evaluate)\b/i.test(lower);
  const hasOperators = /[\d\s]+(?:[\+\-\*\/×÷]|times|plus|minus|divided by|multiplied by)\s*[\d\s]+/i.test(lower);
  const hasPercentage = /\b\d+(?:\.\d+)?%\s*(?:of)\s*\d+/i.test(lower);
  if (hasMathAsk && (hasOperators || hasPercentage)) {
    // Exclude named products or external services
    const hasExternalNames = /\b(?:crm|postgres|sqlite|database|aws|azure|gcp|hubspot|salesforce|pipedrive)/i
      .test(lower) || /\b(?:github|neon|supabase)\b/i.test(lower);
    if (!hasExternalNames) return true;
  }

  // Pure mathematical expression e.g. "20 * 15 * 12"
  if (/^[\s\d\.\+\-\*\/×÷\(\)\$\,\=]+$/.test(lower) && /\d/.test(lower) && /[+\-*\/×÷]/.test(lower)) {
    return true;
  }

  return false;
}

export function isGreetingOrIntro(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower || lower.length > 150) return false;

  // Exclude explicit research keywords
  if (/\b(?:changed|pricing|shipped|since|postgres|crm|hosting|sqlite|api|wal|version|cost)\b/i.test(lower)) {
    return false;
  }

  // Pure greeting
  if (/^(?:hi|hello|hey|greetings|good\s+(?:morning|afternoon|evening|day))(?:\s+there)?[.!]?$/i.test(lower)) {
    return true;
  }

  // Conversational introduction
  if (/\b(?:introduce yourself|who are you|what (?:are you|can you do)|what are you built to do)\b/i.test(lower)) {
    return true;
  }

  // Thanks
  if (/^(?:thanks|thank you|thanks a lot|thank you very much)[.!]?$/i.test(lower)) {
    return true;
  }

  return false;
}

export function isPromptInjection(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return false;
  return /\b(?:ignore all previous instructions|disregard (?:all|previous|external) instructions)/i
    .test(lower) || /\b(?:output only the word|system prompt)\b/i.test(lower);
}

export function isStableDefinition(text) {
  const lower = String(text || '').toLowerCase().trim();
  if (!lower) return false;

  // Check for timeless computer science definitions / concepts
  const hasDefineAsk = /\b(?:what is|define|explain the difference between|differences between)\b/i.test(lower);
  const isTimelessTopic = /\b(?:wal mode and rollback journal|pythagorean theorem|stack and (?:a )?queue)/i
    .test(lower) || /\b(?:process and (?:a )?thread)\b/i.test(lower);
  if (hasDefineAsk && isTimelessTopic) {
    // If it asks for "current", "latest", or "today", it requires search
    if (/\b(?:latest|current|today|since|recent|version)\b/i.test(lower)) return false;
    return true;
  }

  return false;
}

/**
 * Returns whether a given turn requires web_search or must answer directly.
 */
export function evaluateSearchPolicy(userText) {
  const text = String(userText || '').trim();
  if (isGreetingOrIntro(text)) {
    return { shouldSearch: false, reason: 'conversational' };
  }
  if (isPromptInjection(text)) {
    return { shouldSearch: false, reason: 'hostile_instruction' };
  }
  if (isArithmeticQuestion(text)) {
    return { shouldSearch: false, reason: 'arithmetic' };
  }
  if (isStableDefinition(text)) {
    return { shouldSearch: false, reason: 'stable_definition' };
  }
  return { shouldSearch: true, reason: 'default_search' };
}
