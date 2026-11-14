/** Canonical status and evidence wording shared by server logic and the browser UI. */
export const USER_STRINGS = Object.freeze({
  changed: 'Changed',
  changedNewerVersion: 'Changed (newer version)',
  sameAsBefore: 'Same as before',
  cannotCompareTerms: 'Can’t compare: terms differ',
  noEarlierRecord: 'No earlier record to compare',
  couldntConfirm: 'Couldn’t confirm',
  sameAsEarlierAnswer: 'Same as my earlier answer',
  differsFromEarlierAnswer: 'Differs from my earlier answer',
  officialSiteVerified: 'Official site (verified)',
  vendorSiteNotVerified: 'Vendor site (not verified)',
  nameMatchedDomainNotVerified: 'Vendor site (not verified)',
  thirdParty: 'Third party',
  siteNotVerifiedSuffix: ' (site not verified)',
  searchSnippetPageNotVerified: '(Search snippet, page not verified)',
  figureNotVerified: '(figure not verified)',
  calculated: 'calculated',
  originallyGenerated: 'originally generated',
  generationDateUnknown: 'generation date unknown',
  reportedSince: 'Reported since',
});

export function reportedSinceLabel(date) {
  return date ? `${USER_STRINGS.reportedSince} ${date}` : '';
}

export function originallyGeneratedLabel(date) {
  return date ? `${USER_STRINGS.originallyGenerated} ${date}` : '';
}
