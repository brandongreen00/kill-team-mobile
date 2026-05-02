// Test fixture: pre-seeded roster + map id installed via page.addInitScript.
// We use the KASRKIN faction (ids verified via tests/unit/load.js) so the
// game can build operatives without us walking through the roster builder.

const KASRKIN_ROSTER_A = {
  id: 'r_e2e_blue',
  name: 'Blue Test Squad',
  factionId: 'kasrkin',
  picks: [
    { uid: 'u1', operativeId: 'kasrkin-sergeant' },
    { uid: 'u2', operativeId: 'kasrkin-combat-medic' },
    { uid: 'u3', operativeId: 'kasrkin-demo-trooper' },
  ],
};

const KASRKIN_ROSTER_B = {
  id: 'r_e2e_red',
  name: 'Red Test Squad',
  factionId: 'kasrkin',
  picks: [
    { uid: 'u1', operativeId: 'kasrkin-sergeant' },
    { uid: 'u2', operativeId: 'kasrkin-combat-medic' },
    { uid: 'u3', operativeId: 'kasrkin-demo-trooper' },
  ],
};

async function seedGame(page, { mapId = 'tomb-1' } = {}) {
  await page.addInitScript(({ rosters, mapId }) => {
    try {
      localStorage.setItem('kt.rosters.v1', JSON.stringify(rosters));
      sessionStorage.setItem('kt.mapId', mapId);
    } catch (e) {}
  }, { rosters: [KASRKIN_ROSTER_A, KASRKIN_ROSTER_B], mapId });
}

// Force the next two Math.random() calls so the initiative roll has a clear
// winner (finalA = 6, finalB = 1 → team A wins). Subsequent calls (the dice
// tumble animation) fall through to the real RNG.
async function seedInitiativeWinner(page, winner = 'A') {
  await page.addInitScript((winnerTeam) => {
    let n = 0;
    const orig = Math.random;
    Math.random = function () {
      n++;
      if (n === 1) return winnerTeam === 'A' ? 0.95 : 0.0;
      if (n === 2) return winnerTeam === 'A' ? 0.0 : 0.95;
      return orig.call(Math);
    };
  }, winner);
}

module.exports = { KASRKIN_ROSTER_A, KASRKIN_ROSTER_B, seedGame, seedInitiativeWinner };
