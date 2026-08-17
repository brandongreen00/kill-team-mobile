// Tac Ops + Crit Ops data (Approved Ops 2025, via wahapedia.ru/kill-team3).
// Pure data + a few pure helpers on window.KT_OPS; all game state handling
// lives in game.js.
//
// Faction archetypes verified against each team's wahapedia page. Special
// cases: inquisitorial-agent may pick ANY archetype; blades-of-khaine is
// Seek & Destroy plus an aspect-dependent second (we offer all four).

(function (root) {
  const ARCHETYPES = ['Seek & Destroy', 'Security', 'Infiltration', 'Recon'];

  const FACTION_ARCHETYPES = {
    'kasrkin':                ['Seek & Destroy', 'Security'],
    'angels-of-death':        ['Seek & Destroy', 'Security'],
    'battleclade':            ['Infiltration', 'Recon'],
    'celestian-insidiants':   ['Seek & Destroy', 'Security'],
    'death-korps':            ['Seek & Destroy', 'Security'],
    'deathwatch':             ['Seek & Destroy', 'Security'],
    'elucidian-starstrider':  ['Security', 'Recon'],
    'exaction-squad':         ['Seek & Destroy', 'Security'],
    'hunter-clade':           ['Seek & Destroy', 'Recon'],
    'inquisitorial-agent':    ARCHETYPES.slice(),
    'imperial-navy-breacher': ['Seek & Destroy', 'Security'],
    'novitiates':             ['Security', 'Recon'],
    'phobos-strike-team':     ['Infiltration', 'Recon'],
    'ratlings':               ['Security', 'Infiltration'],
    'sanctifiers':            ['Seek & Destroy', 'Security'],
    'scout-squad':            ['Infiltration', 'Recon'],
    'tempestus-aquilons':     ['Seek & Destroy', 'Recon'],
    'wolf-scouts':            ['Seek & Destroy', 'Recon'],
    'blooded':                ['Seek & Destroy', 'Infiltration'],
    'chaos-cult':             ['Seek & Destroy', 'Infiltration'],
    'fellgor-ravager':        ['Seek & Destroy', 'Recon'],
    'gellerpox-infected':     ['Seek & Destroy', 'Security'],
    'goremonger':             ['Seek & Destroy', 'Recon'],
    'legionary':              ['Seek & Destroy', 'Security'],
    'murderwing':             ['Seek & Destroy', 'Recon'],
    'nemesis-claw':           ['Seek & Destroy', 'Infiltration'],
    'plague-marines':         ['Seek & Destroy', 'Security'],
    'warpcoven':              ['Security', 'Recon'],
    'blades-of-khaine':       ARCHETYPES.slice(),
    'brood-brother':          ['Security', 'Infiltration'],
    'canoptek-circle':        ['Security', 'Recon'],
    'corsair-voidscarred':    ['Infiltration', 'Recon'],
    'farstalker-kinband':     ['Infiltration', 'Recon'],
    'hand-of-the-archon':     ['Seek & Destroy', 'Recon'],
    'hernkyn-yaegir':         ['Seek & Destroy', 'Infiltration'],
    'hierotek-circle':        ['Security', 'Recon'],
    'kommandos':              ['Seek & Destroy', 'Infiltration'],
    'mandrakes':              ['Infiltration', 'Recon'],
    'pathfinders':            ['Infiltration', 'Recon'],
    'raveners':               ['Seek & Destroy', 'Infiltration'],
    'vespid-stingwings':      ['Seek & Destroy', 'Recon'],
    'void-dancer-troupe':     ['Infiltration', 'Recon'],
    'wrecka-krew':            ['Seek & Destroy', 'Security'],
    'wyrmblade':              ['Seek & Destroy', 'Infiltration'],
    'xv26-stealth-battlesuits': ['Infiltration', 'Recon'],
  };

  // Automatable universal tac ops (2 per archetype). Max 6VP each.
  // `summary` is shown at selection; `scoring` is the in-game reminder.
  const TAC_OPS = [
    {
      id: 'rout', name: 'Rout', archetype: 'Seek & Destroy',
      summary: 'Score for kills scored deep in enemy territory.',
      scoring: 'Whenever a friendly operative incapacitates an enemy while within 6" of the opponent\'s drop zone: 1VP (2VP if the victim had 12+ Wounds). Max 2VP per turning point.',
    },
    {
      id: 'dominate', name: 'Dominate', archetype: 'Seek & Destroy',
      summary: 'Your killers earn tokens; cash them in late-game.',
      scoring: 'Each kill grants the killer a Dominate token (2 if the victim had 12+ Wounds). At the end of TP3 and TP4, remove tokens from surviving friendlies: 1VP each (max 3VP per scoring).',
    },
    {
      id: 'martyrs', name: 'Martyrs', archetype: 'Security',
      summary: 'Falling on objectives fuels later scoring.',
      scoring: 'When a friendly is incapacitated while contesting an objective, that marker gains a Martyr token. End of TP2–4: remove tokens from markers friendlies contest — 1VP each, 2VP each if friendlies also control that marker. Max 2VP per turning point.',
    },
    {
      id: 'envoy', name: 'Envoy', archetype: 'Security',
      summary: 'Send a fresh envoy into enemy territory each turning point.',
      scoring: 'Each TP after the first an envoy is auto-selected (deepest friendly in enemy territory, never the same twice). End of TP: envoy wholly in enemy territory and out of enemy control range — 1VP; 2VP instead if it also lost no wounds this TP.',
    },
    {
      id: 'flank', name: 'Flank', archetype: 'Recon',
      summary: 'Control the left/right flanks of the enemy half.',
      scoring: 'End of TP2–4: 1VP per flank controlled (higher friendly APL wholly within that flank of the opponent\'s territory). In TP4, a flank also controlled at the end of TP3 scores 2VP instead. Max 2VP per turning point.',
    },
    {
      id: 'scout', name: 'Scout Enemy Movement', archetype: 'Recon',
      summary: 'Concealed operatives mark distant enemies for observation.',
      scoring: 'Scout (1AP, Conceal order, not TP1): mark a ready enemy visible and more than 6" away as monitored until the next Ready step. End of TP: 1VP per monitored enemy visible to friendlies. Max 2VP per turning point.',
    },
    {
      id: 'track', name: 'Track Enemy', archetype: 'Infiltration',
      summary: 'Shadow enemies with concealed spotters.',
      scoring: 'An enemy is tracked while a concealed friendly within 6" could target it without being targetable back (and is out of enemy control range). End of TP2–4: one tracked — 1VP (2VP in TP4); two or more — 2VP. Max 2VP per turning point.',
    },
    {
      id: 'plant-devices', name: 'Plant Devices', archetype: 'Infiltration',
      summary: 'Rig objectives with devices, then keep enemies close to them.',
      scoring: 'Plant Device (1AP, not TP1, on a controlled objective): the marker gains your Device token. End of TP2–4: the opponent\'s marker with your token — 1VP; each other tokened marker that enemies contest — 1VP. Max 2VP per turning point.',
    },
  ];

  // Shared crit ops (Preliminary Ops trio; also part of Approved Ops 2025).
  const CRIT_OPS = [
    {
      id: 'secure', name: 'Secure',
      action: 'Secure (1AP)',
      summary: 'Secure objectives you control; they stay yours until re-secured.',
      scoring: 'Secure (1AP, not TP1): a controlled marker becomes secured by your team until the enemy secures it. End of TP2–4: any marker secured — 1VP; more markers secured than your opponent — 1VP.',
    },
    {
      id: 'loot', name: 'Loot',
      action: 'Loot (1AP)',
      summary: 'Repeatedly loot objectives you control.',
      scoring: 'Loot (1AP, not TP1, once per marker per turning point): score 1VP per Loot action, max 2VP per turning point.',
    },
    {
      id: 'transmission', name: 'Transmission',
      action: 'Initiate Transmission (1AP)',
      summary: 'Set objectives transmitting, then hold them.',
      scoring: 'Initiate Transmission (1AP, not TP1): the marker transmits until the next turning point. End of TP2–4: control any transmitting marker — 1VP; control more transmitting markers than your opponent — 1VP.',
    },
  ];

  function archetypesFor(factionId) {
    return FACTION_ARCHETYPES[factionId] || ['Seek & Destroy', 'Security'];
  }
  function tacOpsFor(factionId) {
    const arcs = archetypesFor(factionId);
    return TAC_OPS.filter(t => arcs.includes(t.archetype));
  }
  function tacOpById(id) { return TAC_OPS.find(t => t.id === id) || null; }
  function critOpById(id) { return CRIT_OPS.find(c => c.id === id) || null; }

  root.KT_OPS = {
    ARCHETYPES,
    FACTION_ARCHETYPES,
    TAC_OPS,
    CRIT_OPS,
    archetypesFor,
    tacOpsFor,
    tacOpById,
    critOpById,
  };
})(typeof window !== 'undefined' ? window : globalThis);
