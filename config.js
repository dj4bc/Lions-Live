// Season settings. Update these when a new season or competition starts.
// To find the values: open the club's BasketballConnect fixture page, open the
// browser's developer tools (Network tab), and look for the
// "round/matches?competitionId=" request.
window.LIONS_CONFIG = {
  seasonLabel: '2026/27 Junior Season',
  apiBase: 'https://api-basketball.squadi.com',
  competitionId: 2890, // numeric id used by the matches endpoint
  // Every Lions team in this competition. Team names must contain clubMatch.
  teamIds: [
    156633, 156634, 156635, 156636, 156637, 156638, 156639, 156640, 156641, 156642,
    156643, 156644, 156645, 156646, 156647, 156648, 156649, 156650, 156651, 156652,
    156653, 156654, 156655, 156656, 156657, 156658, 156659, 156660, 156661, 156662,
    156663, 156664, 156665, 156666, 156667, 156668, 156669, 156670, 156671, 156672,
    156673
  ],
  clubMatch: 'Central Districts Lions',
  timeZone: 'Australia/Adelaide',
  // How often to refresh while any Lions game is live (milliseconds).
  liveRefreshMs: 60000,
  sourceUrl: 'https://registration.basketballconnect.com/livescoreSeasonFixture?organisationKey=647be66c-51a1-440c-a213-05532c020016&yearId=9&competitionUniqueKey=8cf25d3b-1b2d-41c0-a4c7-c87389aeafda&divisionId=All'
};
