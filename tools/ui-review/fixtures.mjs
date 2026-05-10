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

// Use Approved Ops 2 for combat-state captures: it's the densest map in the
// catalog (23 pieces — long/short walls, terrain, two teleport pads, three
// objectives across the player A / neutral / player B spawn lines), so it
// surfaces real layout density rather than the near-empty tomb-1 reference.
export const defaultMapId = 'tomb-approved-2';
