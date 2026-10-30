// Traffic categories, confidence labels and verification states shared by the
// classifier, storage and notification layers.

export const CATEGORY = Object.freeze({
  HUMAN: 'human_browser_candidate',
  SOCIAL: 'social_preview_crawler',
  SEARCH: 'search_engine_crawler',
  AI: 'ai_crawler',
  AGENT: 'automated_agent',
  SCANNER: 'security_scanner',
  UNKNOWN: 'unknown',
});

export const CATEGORY_LABEL = Object.freeze({
  [CATEGORY.HUMAN]: 'Human browser candidate',
  [CATEGORY.SOCIAL]: 'Social media preview crawler',
  [CATEGORY.SEARCH]: 'Search engine crawler',
  [CATEGORY.AI]: 'AI indexing / AI search crawler',
  [CATEGORY.AGENT]: 'Automated agent / browser automation',
  [CATEGORY.SCANNER]: 'Security scanner / monitoring service',
  [CATEGORY.UNKNOWN]: 'Unknown / unclassified',
});

// Confidence describes how sure we are about the *category* assignment.
// Identity of a named crawler is described separately by VERIFICATION.
export const CONFIDENCE = Object.freeze({
  VERIFIED: 'Verified',
  HIGH: 'High confidence',
  MEDIUM: 'Medium confidence',
  LOW: 'Low confidence',
  UNKNOWN: 'Unknown',
});

export const CONFIDENCE_RANK = Object.freeze({
  [CONFIDENCE.UNKNOWN]: 0,
  [CONFIDENCE.LOW]: 1,
  [CONFIDENCE.MEDIUM]: 2,
  [CONFIDENCE.HIGH]: 3,
  [CONFIDENCE.VERIFIED]: 4,
});

export const VERIFICATION = Object.freeze({
  VERIFIED: 'verified',
  FAILED: 'failed', // claims to be a known crawler but the network origin does not match
  UNVERIFIED: 'unverified', // no verification method available, or lookup failed
  NOT_APPLICABLE: 'not_applicable',
});

export function isCategory(value) {
  return Object.values(CATEGORY).includes(value);
}
