// Preset kill teams — community-consensus "best loadout" rosters that can be
// picked instantly on the game's team-select screen (and imported into the
// roster editor). Loadouts follow 2024-edition tactics guides (Goonhammer /
// Tabletop Battles / r/killteam tournament lists); see the repo history for
// the research notes.
//
// Shape mirrors localStorage['kt.rosters.v1'] entries:
//   { id, name, factionId, picks: [{ uid, operativeId, rangedChoice?, meleeChoice? }] }
// rangedChoice / meleeChoice may be a single weapon base name or an array of
// base names (operatives that genuinely carry several ranged weapons).

(function (root) {
  function picksOf(list) {
    return list.map((p, i) => ({
      uid: 'preset-' + (i + 1),
      operativeId: p[0],
      rangedChoice: p[1] || null,
      meleeChoice: p[2] || null,
    }));
  }

  const PRESETS = [
    {
      id: 'preset-angels-of-death',
      factionId: 'angels-of-death',
      name: 'Angels of Death — Strike Force',
      blurb: 'Captain with plasma & fist, sniper overwatch, grenadier pressure. Durable and forgiving.',
      picks: picksOf([
        ['aod-captain'],
        ['aod-eliminator-sniper'],                                   // bolt pistol + sniper rifle
        ['aod-assault-grenadier'],                                   // pistol + frag/krak
        ['aod-intercessor-gunner', ['Auto bolt rifle', 'Auxiliary grenade launcher']],
        ['aod-assault-warrior'],
        ['aod-intercessor-warrior', 'Bolt rifle'],
      ]),
    },
    {
      id: 'preset-kasrkin',
      factionId: 'kasrkin',
      name: 'Kasrkin — Veteran Strike Squad',
      blurb: 'Plasma / grenade launcher / melta gunners with full support staff — the standard tournament ten.',
      picks: picksOf([
        ['kasrkin-sergeant', 'Plasma pistol', 'Power weapon'],
        ['kasrkin-gunner', 'Plasma gun'],
        ['kasrkin-gunner', 'Grenade launcher'],
        ['kasrkin-gunner', 'Meltagun'],
        ['kasrkin-sharpshooter'],
        ['kasrkin-combat-medic'],
        ['kasrkin-demo-trooper'],
        ['kasrkin-recon-trooper'],
        ['kasrkin-vox-trooper'],
        ['kasrkin-trooper'],
      ]),
    },
    {
      id: 'preset-kommandos',
      factionId: 'kommandos',
      name: 'Kommandos — Da Sneaky Ladz',
      blurb: 'Power Klaw Nob, all seven specialist boyz, and the bomb squig. Kunning and brutal.',
      picks: picksOf([
        ['ko-boss-nob', null, 'Power Klaw'],
        ['ko-breacha-boy'],
        ['ko-slasha-boy'],
        ['ko-snipa-boy'],
        ['ko-rokkit-boy'],
        ['ko-burna-boy'],
        ['ko-dakka-boy'],
        ['ko-comms-boy'],
        ['ko-boy'],
        ['ko-bomb-squig'],
        ['ko-grot'],
      ]),
    },
    {
      id: 'preset-pathfinders',
      factionId: 'pathfinders',
      name: 'Pathfinders — Rail Cadre',
      blurb: 'Twin rail rifles plus the marksman behind a markerlight net; drones screen and scout.',
      picks: picksOf([
        ['pf-shasui'],
        ['pf-weapons-expert', 'Rail rifle'],
        ['pf-weapons-expert', 'Rail rifle'],
        ['pf-marksman'],
        ['pf-assault-grenadier'],
        ['pf-medical-technician'],
        ['pf-comms-specialist'],
        ['pf-blooded'],
        ['pf-mb3-recon-drone'],
        ['pf-mv4-shield-drone'],
        ['pf-mv1-gun-drone'],
        ['pf-shasla'],
      ]),
    },
    {
      id: 'preset-legionary',
      factionId: 'legionary',
      name: 'Legionary — Chosen of Chaos',
      blurb: 'Daemon-blade Chosen, reaper chaincannon, meltagun and the Butcher. Kills anything it touches.',
      picks: picksOf([
        ['lg-chosen', 'Plasma pistol'],
        ['lg-heavy-gunner', ['Bolt pistol', 'Reaper chaincannon']],
        ['lg-gunner', ['Bolt pistol', 'Meltagun']],
        ['lg-balefire-acolyte', ['Bolt pistol', 'Fireblast']],
        ['lg-butcher'],
        ['lg-anointed'],
      ]),
    },
    {
      id: 'preset-plague-marines',
      factionId: 'plague-marines',
      name: 'Plague Marines — The Rotten Six',
      blurb: 'Flail Fighter, plague spewer, plaguecaster. Slow, implacable, extremely hard to kill.',
      picks: picksOf([
        ['pm-champion'],
        ['pm-fighter'],
        ['pm-heavy-gunner'],
        ['pm-plaguecaster'],
        ['pm-bombardier'],
        ['pm-warrior'],
      ]),
    },
    {
      id: 'preset-blades-of-khaine',
      factionId: 'blades-of-khaine',
      name: 'Blades of Khaine — Aspect Strike',
      blurb: 'Scorpion Exarch with claw & chainsword, banshee charges, avenger objective holders.',
      picks: picksOf([
        ['bk-striking-scorpion-exarch', 'Shuriken pistol', "Scorpion's claw and chainsword"],
        ['bk-striking-scorpion-warrior'],
        ['bk-striking-scorpion-warrior'],
        ['bk-howling-banshee-warrior'],
        ['bk-howling-banshee-warrior'],
        ['bk-howling-banshee-warrior'],
        ['bk-dire-avenger-warrior'],
        ['bk-dire-avenger-warrior'],
      ]),
    },
    {
      id: 'preset-vespid-stingwings',
      factionId: 'vespid-stingwings',
      name: 'Vespid Stingwings — Neutron Swarm',
      blurb: 'Every specialist plus four neutron blaster warriors. Fast, flying, Devastating everywhere.',
      picks: picksOf([
        ['vp-strain-leader'],
        ['vp-oversight-drone'],
        ['vp-longsting'],
        ['vp-skyblast'],
        ['vp-shadestrain'],
        ['vp-swarmguard'],
        ['vp-warrior'],
        ['vp-warrior'],
        ['vp-warrior'],
        ['vp-warrior'],
      ]),
    },
  ];

  root.KT_PRESETS = PRESETS;
})(typeof window !== 'undefined' ? window : globalThis);
