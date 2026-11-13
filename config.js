// Season settings. Update these when a new season or competition starts.
// To find the values: open the club's BasketballConnect fixture page, open the
// browser's developer tools (Network tab), and look for the
// "round/matches?competitionId=" request.
window.LIONS_CONFIG = {
  seasonLabel: '2026/27 Season',
  apiBase: 'https://api-basketball.squadi.com',
  // Each competition: the numeric id used by the matches endpoint, a short label,
  // and every Lions team in it. Team names must contain clubMatch.
  competitions: [
    {
      id: 2890, label: 'Juniors',
      sourceUrl: 'https://registration.basketballconnect.com/livescoreSeasonFixture?organisationKey=647be66c-51a1-440c-a213-05532c020016&yearId=9&competitionUniqueKey=8cf25d3b-1b2d-41c0-a4c7-c87389aeafda&divisionId=All',
      teamIds: [
        156633, 156634, 156635, 156636, 156637, 156638, 156639, 156640, 156641, 156642,
        156643, 156644, 156645, 156646, 156647, 156648, 156649, 156650, 156651, 156652,
        156653, 156654, 156655, 156656, 156657, 156658, 156659, 156660, 156661, 156662,
        156663, 156664, 156665, 156666, 156667, 156668, 156669, 156670, 156671, 156672,
        156673
      ]
    },
    {
      id: 2892, label: 'YDL', // U21 men, U23 women
      sourceUrl: 'https://registration.basketballconnect.com/livescoreSeasonFixture?organisationKey=647be66c-51a1-440c-a213-05532c020016&yearId=9&competitionUniqueKey=308f128f-4983-49de-b670-13fd3bd60f66&divisionId=All',
      teamIds: [156952, 156953, 156954, 156955, 156956, 156957, 156974]
    },
    {
      id: 2891, label: 'SDL', // senior men and women, plus reserves
      sourceUrl: 'https://registration.basketballconnect.com/livescoreSeasonFixture?organisationKey=647be66c-51a1-440c-a213-05532c020016&yearId=9&competitionUniqueKey=964e1208-fbb0-424f-9445-8fe1d504f2a6&divisionId=All',
      teamIds: [156881, 156882, 156883, 156884, 156885]
    }
  ],
  clubMatch: 'Central Districts Lions',
  // Sponsors. Logos live in the sponsors/ folder. Remove an entry (or set it to null) to hide that spot.
  sponsors: {
    list: {
      mazda: { name: 'Barossa Mazda', logo: 'sponsors/barossa-mazda.png', url: 'https://www.barossamazda.com.au/', dark: true },
      injuryhub: {
        name: 'The Injury Hub', logo: 'sponsors/injury-hub.png', url: 'https://theinjuryhub.com.au/',
        blurb: 'Physio, rehab and classes in Willaston. Sprains, strains and niggles sorted.', cta: 'Book online'
      }
    },
    presenting: 'mazda',            // "Game day presented by" strip under the header (Game day page)
    wall: ['mazda', 'injuryhub'],   // "Thanks to our sponsors" wall above the footer (every page)
    wallSlots: 4,                   // empty "Your logo here" spots on the wall, to sell
    feed: 'injuryhub',              // sponsor card between the days on the Game day page
    teams: {                        // team sponsors, by team name as shown on the team page
      'U14 Boys Lions 1': 'injuryhub'
    }
  },
  // Where the live foul tracker's data lives (the Linode scraper). Leave empty to hide the fouls card.
  foulsBase: 'https://fouls.adamforb.es',
  timeZone: 'Australia/Adelaide',
  // How often to refresh while any Lions game is live (milliseconds).
  liveRefreshMs: 60000
};
