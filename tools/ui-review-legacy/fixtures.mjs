// Sample data injected into localStorage / sessionStorage before page scripts
// run, so that screens that normally require user input (the team picker on
// game.html, the populated roster list on roster.html) can be captured.
//
// Roster shape mirrors what roster.html writes to localStorage['kt.rosters.v1']:
//   { id, name, factionId, picks: [{ uid, operativeId, rangedChoice?, meleeChoice? }] }
// Pick fields match what game.js's unitsFromRoster() reads.

export const sampleRosters = [
  {
    id: 'fixture-kasrkin',
    name: 'Strike Squad Vortigern',
    factionId: 'kasrkin',
    picks: [
      { uid: 'p1', operativeId: 'kasrkin-sergeant' },
      { uid: 'p2', operativeId: 'kasrkin-combat-medic' },
      { uid: 'p3', operativeId: 'kasrkin-gunner', rangedChoice: 'Hot-shot volley gun' },
      { uid: 'p4', operativeId: 'kasrkin-sharpshooter' },
      { uid: 'p5', operativeId: 'kasrkin-vox-trooper' },
      { uid: 'p6', operativeId: 'kasrkin-trooper' },
      { uid: 'p7', operativeId: 'kasrkin-trooper' },
      { uid: 'p8', operativeId: 'kasrkin-trooper' },
    ],
  },
  {
    id: 'fixture-aod',
    name: 'Iron Brotherhood',
    factionId: 'angels-of-death',
    picks: [
      { uid: 'p1', operativeId: 'aod-intercessor-sergeant' },
      { uid: 'p2', operativeId: 'aod-intercessor-gunner' },
      { uid: 'p3', operativeId: 'aod-intercessor-warrior' },
      { uid: 'p4', operativeId: 'aod-intercessor-warrior' },
      { uid: 'p5', operativeId: 'aod-eliminator-sniper' },
      { uid: 'p6', operativeId: 'aod-heavy-gunner' },
    ],
  },
];

// The only built-in map after the catalog was trimmed down to Approved Ops.
// Custom user-authored maps land in localStorage['kt.customMaps'] and merge
// in via KT.getMap(); seed those if you want to capture a custom layout.
export const defaultMapId = 'tomb-approved-2';
