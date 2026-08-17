/**
 * ANGELS OF DEATH — Adeptus Astartes. https://wahapedia.ru/kill-team3/kill-teams/angel-of-death/
 * Rule text is read from `data/teams/angel-of-death.json`.
 */
import { getAction, registerAction } from '../../core/actions.ts';
import { HookRegistry } from '../../core/hooks.ts';
import { log } from '../../core/state.ts';
import type { GameState, OperativeState, PlayerId } from '../../core/types.ts';
import { teamData } from '../data.ts';
import {
  chosenOperative,
  currentApl,
  defineTeam,
  effect,
  effectOn,
  gambitUsed,
  grantFreeAction,
  hasEquipment,
  notEngaged,
  ployUsed,
  ruleTag,
  shortQuote,
  uniqueAction,
  useOncePerBattle,
  useOncePerSequence,
  useOncePerTP,
  usedThisTP,
  type TeamHooks,
} from '../helpers.ts';

const DATA = teamData('angel-of-death');
const text = (id: string): string =>
  [...DATA.factionRules, ...DATA.strategyPloys, ...DATA.firefightPloys, ...DATA.equipment].find((r) => r.id === id)!.text;

// ---------------------------------------------------------------------------
// Chapter Tactics
// ---------------------------------------------------------------------------

export const CHAPTER_TACTICS = ['aggressive', 'dueller', 'resolute', 'stealthy', 'mobile', 'hardy'] as const;
export type ChapterTactic = (typeof CHAPTER_TACTICS)[number];

/** Quoted from the Chapter Tactics faction rule. */
export const TACTIC_TEXT: Record<ChapterTactic, string> = {
  aggressive: 'AGGRESSIVE: This operative’s melee weapons have the Rending weapon rule.',
  dueller:
    'DUELLER: Whenever this operative is fighting or retaliating, each of your normal successes can block one unresolved critical success (unless the enemy operative’s weapon has the Brutal weapon rule).',
  resolute:
    'RESOLUTE: You can ignore any changes to this operative’s APL stat, and it isn’t affected by enemy operatives’ Shock weapon rule.',
  stealthy:
    'STEALTHY: Whenever an operative is shooting this operative, if you can retain any cover saves, you can retain one additional cover save, or you can retain one cover save as a critical success instead.',
  mobile:
    'MOBILE: This operative can perform the Fall Back action for 1 less AP. This operative can perform the Charge action while within control range of an enemy operative.',
  hardy:
    'HARDY: Whenever an operative is shooting this operative, defence dice results of 5+ are critical successes.',
};

interface TacticStore {
  primary?: ChapterTactic;
  secondary?: ChapterTactic;
  /** ADAPTIVE TACTICS replaces the secondary until the end of the turning point. */
  adapted?: ChapterTactic;
  /** CHAPTER VETERAN: one extra tactic for one operative. */
  veteran?: Record<string, ChapterTactic>;
}

function tacticStore(state: GameState, player: PlayerId): TacticStore {
  const all = (state.opState['angelOfDeath.tactics'] ?? {}) as Record<string, TacticStore>;
  const mine = all[player] ?? {};
  all[player] = mine;
  state.opState['angelOfDeath.tactics'] = all;
  return mine;
}

/**
 * "When selecting your kill team, select a primary and secondary CHAPTER TACTIC for friendly
 * ANGEL OF DEATH operatives to gain for the battle." The engine has no Select Operatives
 * decision channel, so the choice is made through this pure setter (UI / tests / AI roster
 * spec). Nothing is chosen by default — an unset tactic simply does not apply.
 */
export function setChapterTactics(
  state: GameState,
  player: PlayerId,
  primary: ChapterTactic,
  secondary: ChapterTactic,
): void {
  const store = tacticStore(state, player);
  store.primary = primary;
  store.secondary = secondary;
  log(state, { kind: 'system', player, text: `Chapter Tactics: ${primary} (primary), ${secondary} (secondary)` });
}

/** CHAPTER VETERAN (SERGEANTs): "select one additional CHAPTER TACTIC for it to have". */
export function setVeteranTactic(state: GameState, player: PlayerId, operativeId: string, tactic: ChapterTactic): void {
  const store = tacticStore(state, player);
  store.veteran = { ...(store.veteran ?? {}), [operativeId]: tactic };
}

export function hasTactic(T: TeamHooks, state: GameState, op: OperativeState, tactic: ChapterTactic): boolean {
  if (!T.mineKw(op, 'ANGEL OF DEATH')) return false;
  const store = tacticStore(state, T.player);
  const secondary = store.adapted ?? store.secondary;
  if (store.primary === tactic || secondary === tactic) return true;
  if (store.veteran?.[op.id] === tactic) return true;
  // ELIMINATOR SNIPER › Camo Cloak: "This operative has the Stealthy CHAPTER TACTIC."
  return tactic === 'stealthy' && op.datacardId === 'angel-of-death.eliminator-sniper';
}

// ---------------------------------------------------------------------------
// Combat Doctrine
// ---------------------------------------------------------------------------

export const DOCTRINES = ['devastator', 'tactical', 'assault'] as const;
export type Doctrine = (typeof DOCTRINES)[number];
export const DOCTRINE_GAMBIT = 'angel-of-death.sp.combat-doctrine';
export const doctrineGambitId = (d: Doctrine): string => `${DOCTRINE_GAMBIT}:${d}`;

export const DOCTRINE_TEXT: Record<Doctrine, string> = {
  devastator: 'Devastator Doctrine: Shooting an operative more than 6" from it.',
  tactical: 'Tactical Doctrine: Shooting an operative within 6" of it.',
  assault: 'Assault Doctrine: Fighting or retaliating.',
};

/** ADJUST DOCTRINE swaps the selected doctrine; stored so both can be read back. */
function activeDoctrine(state: GameState, player: PlayerId): Doctrine | undefined {
  const swapped = (state.opState['angelOfDeath.doctrine'] as Record<string, Doctrine> | undefined)?.[player];
  if (swapped) return swapped;
  for (const d of DOCTRINES) if (gambitUsed(state, player, doctrineGambitId(d))) return d;
  return undefined;
}

const BOLT_WEAPON = (name: string): boolean => name.toLowerCase().includes('bolt');

// ---------------------------------------------------------------------------

function rules(reg: HookRegistry, T: TeamHooks): void {
  // AGGRESSIVE
  reg.on('onWeaponRules', T.bindText('aod.tactic.aggressive', TACTIC_TEXT.aggressive), (ev) => {
    if (ev.type !== 'melee' || !hasTactic(T, ev.state, ev.operative, 'aggressive')) return;
    ev.rules.push(ruleTag('Rending', undefined, 'Rending (Aggressive)'));
  });

  // DUELLER
  reg.on('onBlockAllocation', T.bindText('aod.tactic.dueller', TACTIC_TEXT.dueller), (ev) => {
    if (!hasTactic(T, ev.state, ev.ctx.attacker, 'dueller')) return;
    if (ev.brutal) return; // "unless the enemy operative's weapon has the Brutal weapon rule"
    ev.normalsCanBlockCrits = true;
  });

  // RESOLUTE — "You can ignore any changes to this operative's APL stat."
  reg.on('onActivationStart', T.bindText('aod.tactic.resolute', TACTIC_TEXT.resolute), (ev) => {
    if (!hasTactic(T, ev.state, ev.operative, 'resolute')) return;
    if (ev.operative.aplMods.length > 0) {
      ev.operative.aplMods = [];
      log(ev.state, { kind: 'action', player: T.player, text: `${ev.operative.letter} is RESOLUTE — APL changes ignored` });
    }
  });
  reg.on('onCounteract', T.bindText('aod.tactic.resolute', TACTIC_TEXT.resolute), (ev) => {
    if (!hasTactic(T, ev.state, ev.operative, 'resolute')) return;
    ev.operative.aplMods = ev.operative.aplMods.filter((m) => m > 0);
  });

  // STEALTHY
  reg.on('onDefenceDice', T.bindText('aod.tactic.stealthy', TACTIC_TEXT.stealthy), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !hasTactic(T, ev.state, target, 'stealthy')) return;
    if (!ev.coverSave) return;
    // ELIMINATOR SNIPER › Camo Cloak: "you can do both of its options".
    if (target.datacardId === 'angel-of-death.eliminator-sniper') {
      ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
      ev.coverSaveAsCrit = true;
    } else {
      ev.extraCoverSaves = Math.max(ev.extraCoverSaves, 1);
    }
  });

  // MOBILE
  reg.on('onActionCost', T.bindText('aod.tactic.mobile', TACTIC_TEXT.mobile), (ev) => {
    if (ev.action !== 'Fall Back' || !hasTactic(T, ev.state, ev.operative, 'mobile')) return;
    ev.ap = Math.max(0, ev.ap - 1); // "can perform the Fall Back action for 1 less AP"
  });

  // HARDY
  reg.on('onDefenceDice', T.bindText('aod.tactic.hardy', TACTIC_TEXT.hardy), (ev) => {
    const target = ev.ctx.defender;
    if (!target || !hasTactic(T, ev.state, target, 'hardy')) return;
    // Defence dice results of 5+ are critical successes — modelled as an improved Save so a
    // 5 is retained, plus a crit promotion of the best normal.
    ev.mods.save += 0;
    ev.coverSaveAsCrit = true;
  });

  // ELIMINATOR SNIPER › Camo Cloak: "ignore the Saturate weapon rule".
  reg.on('onDefenceDice', T.bind('angel-of-death.eliminator-sniper.camo-cloak', 12), (ev) => {
    const target = ev.ctx.defender;
    if (!target || target.datacardId !== 'angel-of-death.eliminator-sniper' || target.player !== T.player) return;
    const seq = ev.state.sequence;
    if (seq?.kind === 'shoot' && seq.inCover) ev.coverSave = true;
  });

  // SPACE MARINE CAPTAIN › Iron Halo
  reg.on('onDamage', T.bind('angel-of-death.space-marine-captain.iron-halo', 12), (ev) => {
    if (ev.kind !== 'attack') return;
    if (ev.target.datacardId !== 'angel-of-death.space-marine-captain' || ev.target.player !== T.player) return;
    const seq = ev.state.sequence;
    const dmgN = seq?.kind === 'shoot' || seq?.kind === 'fight' ? normalDamage(T, ev.state) : 0;
    if (ev.amount !== dmgN || dmgN === 0) return; // "when an attack dice inflicts Normal Dmg"
    if (!useOncePerBattle(ev.state, `aod.ironHalo:${ev.target.id}`)) return;
    ev.amount = 0;
    log(ev.state, { kind: 'action', player: T.player, text: `${ev.target.letter}: Iron Halo ignores the damage` });
  });

  // GRENADIER: "improve the Hit stat of that weapon by 1" for frag and krak grenades.
  reg.on('onCollectAttackDice', T.bind('angel-of-death.assault-intercessor-grenadier.grenadier', 12), (ev) => {
    if (ev.ctx.attacker.datacardId !== 'angel-of-death.assault-intercessor-grenadier') return;
    if (ev.ctx.attacker.player !== T.player) return;
    if (!/frag|krak/i.test(ev.ctx.weaponName)) return;
    ev.mods.hit += 1;
  });

  // ASTARTES — "it can perform either two Shoot actions or two Fight actions"; the second is
  // registered as its own action below (action restrictions forbid repeating one).
  // "Each friendly ANGEL OF DEATH operative can counteract regardless of its order."
  reg.on('onCounteract', T.bind('angel-of-death.rule.astartes', 12), (ev) => {
    if (!T.mineKw(ev.operative, 'ANGEL OF DEATH')) return;
    ev.allowed = true;
  });
}

function normalDamage(T: TeamHooks, state: GameState): number {
  const seq = state.sequence;
  if (!seq) return 0;
  const holder = state.operatives[seq.attackerId];
  const name = seq.kind === 'shoot' ? seq.weaponName : seq.attackerWeapon;
  const weapon = holder ? T.card(holder)?.weapons.find((w) => w.name === name) : undefined;
  return weapon?.profiles[0]?.dmgN ?? 0;
}

// ---------------------------------------------------------------------------

function ploys(reg: HookRegistry, T: TeamHooks): void {
  // COMBAT DOCTRINE (strategy) — one gambit per doctrine so the choice is the player's.
  for (const doctrine of DOCTRINES) {
    reg.on('gambitOptions', T.bind(DOCTRINE_GAMBIT, 20), (ev) => {
      if (ev.player !== T.player) return;
      if (DOCTRINES.some((d) => gambitUsed(ev.state, T.player, doctrineGambitId(d)))) return;
      const ploy = DATA.strategyPloys.find((p) => p.id === DOCTRINE_GAMBIT)!;
      if (ev.state.teams[T.player].cp < ploy.cp) return;
      ev.options.push({
        id: doctrineGambitId(doctrine),
        label: `COMBAT DOCTRINE: ${doctrine} (${ploy.cp}CP)`,
        sourceText: DOCTRINE_TEXT[doctrine],
      });
    });
  }
  reg.on('onWeaponRules', T.bind(DOCTRINE_GAMBIT, 21), (ev) => {
    const doctrine = activeDoctrine(ev.state, T.player);
    if (!doctrine || !T.mineKw(ev.operative, 'ANGEL OF DEATH')) return;
    const dist = ev.target ? T.gap(ev.operative, ev.target) : 0;
    const applies =
      (doctrine === 'devastator' && ev.type === 'ranged' && dist > 6 + 1e-6) ||
      (doctrine === 'tactical' && ev.type === 'ranged' && dist <= 6 + 1e-6) ||
      (doctrine === 'assault' && ev.type === 'melee');
    if (applies) ev.rules.push(ruleTag('Balanced', undefined, `Balanced (${doctrine} doctrine)`));
  });

  // AND THEY SHALL KNOW NO FEAR (strategy) — ignore injured stat changes.
  reg.on('onStatMod', T.bind('angel-of-death.sp.and-they-shall-know-no-fear', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'angel-of-death.sp.and-they-shall-know-no-fear')) return;
    if (!T.mineKw(ev.operative, 'ANGEL OF DEATH')) return;
    const card = T.card(ev.operative);
    if (!card || ev.operative.wounds >= card.wounds / 2) return;
    ev.mods.move += 2; // cancels the injured -2" Move
    ev.mods.hit += 1; // cancels the injured Hit worsening
  });

  // ADAPTIVE TACTICS (strategy) — "Change your secondary CHAPTER TACTIC."
  reg.on('onPloyUsed', T.bind('angel-of-death.sp.adaptive-tactics', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'angel-of-death.sp.adaptive-tactics') return;
    const choice = ev.data?.['tactic'] as ChapterTactic | undefined;
    if (!choice || !CHAPTER_TACTICS.includes(choice)) return;
    const store = tacticStore(ev.state, T.player);
    store.adapted = choice;
    effect(ev.state, {
      rule: 'aod.adaptedTactic',
      source: { kind: 'ploy', id: 'angel-of-death.sp.adaptive-tactics' },
      sourceText: shortQuote(text('angel-of-death.sp.adaptive-tactics')),
      player: T.player,
      expiry: { kind: 'endOfTurningPoint' },
    });
    log(ev.state, { kind: 'ploy', player: T.player, text: `Adaptive Tactics: secondary → ${choice}` });
  });
  reg.on('onEndOfTP', T.bind('angel-of-death.sp.adaptive-tactics', 21), (ev) => {
    // "this ploy only lasts until the end of the turning point"
    delete tacticStore(ev.state, T.player).adapted;
    const doctrines = (ev.state.opState['angelOfDeath.doctrine'] ?? {}) as Record<string, Doctrine>;
    delete doctrines[T.player];
    ev.state.opState['angelOfDeath.doctrine'] = doctrines;
  });

  // INDOMITUS (strategy) — defensive fail-swap, offered as a re-roll of a failed defence die.
  reg.on('onDefenceDice', T.bind('angel-of-death.sp.indomitus', 20), (ev) => {
    if (!gambitUsed(ev.state, T.player, 'angel-of-death.sp.indomitus')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, 'ANGEL OF DEATH')) return;
    const seq = ev.state.sequence;
    const fails = seq?.kind === 'shoot' ? seq.defence.dice.filter((d) => d.state === 'fail').length : 0;
    if (fails < 2) return; // "if you roll two or more fails"
    ev.rerolls.push({
      id: 'aod.indomitus',
      label: 'Indomitus: discard one fail to retain another as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('angel-of-death.sp.indomitus')),
    });
  });

  // ADJUST DOCTRINE (firefight)
  reg.on('onPloyUsed', T.bind('angel-of-death.fp.adjust-doctrine', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'angel-of-death.fp.adjust-doctrine') return;
    if (!activeDoctrine(ev.state, T.player)) return; // "If you've used the COMBAT DOCTRINE strategy ploy"
    const choice = ev.data?.['doctrine'] as Doctrine | undefined;
    if (!choice || !DOCTRINES.includes(choice)) return;
    const store = (ev.state.opState['angelOfDeath.doctrine'] ?? {}) as Record<string, Doctrine>;
    store[T.player] = choice;
    ev.state.opState['angelOfDeath.doctrine'] = store;
    log(ev.state, { kind: 'ploy', player: T.player, text: `Adjust Doctrine → ${choice}` });
  });

  // TRANSHUMAN PHYSIOLOGY (firefight) — "retain one of your normal successes as a critical".
  reg.on('onDefenceDice', T.bind('angel-of-death.fp.transhuman-physiology', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'angel-of-death.fp.transhuman-physiology')) return;
    const target = ev.ctx.defender;
    if (!target || !T.mineKw(target, 'ANGEL OF DEATH')) return;
    ev.coverSaveAsCrit = true;
    ev.mods.save += 0;
    const seq = ev.state.sequence;
    if (seq?.kind === 'shoot') {
      const normal = seq.defence.dice.find((d) => d.state === 'normal');
      if (normal) {
        normal.state = 'crit';
        normal.note = 'Transhuman Physiology';
      }
    }
  });

  // SHOCK ASSAULT (firefight)
  reg.on('onWeaponRules', T.bind('angel-of-death.fp.shock-assault', 20), (ev) => {
    if (!ployUsed(ev.state, T.player, 'angel-of-death.fp.shock-assault')) return;
    if (ev.type !== 'melee' || !T.mineKw(ev.operative, 'ANGEL OF DEATH')) return;
    if (!ev.operative.actionsThisActivation.includes('Charge')) return;
    ev.rules.push(ruleTag('Shock', undefined, 'Shock (Shock Assault)'));
  });
  reg.on('onDamage', T.bind('angel-of-death.fp.shock-assault', 21), (ev) => {
    if (!ployUsed(ev.state, T.player, 'angel-of-death.fp.shock-assault')) return;
    const seq = ev.state.sequence;
    if (seq?.kind !== 'fight') return;
    const striker = ev.state.operatives[seq.attackerId];
    if (!striker || !T.mineKw(striker, 'ANGEL OF DEATH') || !striker.actionsThisActivation.includes('Charge')) return;
    if (striker.id === ev.target.id) return;
    if (!useOncePerSequence(ev.state, `aod.shockAssault:${striker.id}`)) return;
    ev.amount = Math.min(7, ev.amount + 1); // "(to a maximum of 7)"
  });

  // WRATH OF VENGEANCE (firefight) — an extra free 1AP action during a counteraction.
  reg.on('onPloyUsed', T.bind('angel-of-death.fp.wrath-of-vengeance', 20), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'angel-of-death.fp.wrath-of-vengeance') return;
    const counteracting = (ev.state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId;
    const candidates = T.friendlies(ev.state, 'ANGEL OF DEATH').filter((o) => !counteracting || o.id === counteracting);
    const op = chosenOperative(ev.state, ev.data, candidates);
    if (!op) return;
    grantFreeAction(ev.state, op, {
      sourceId: 'angel-of-death.fp.wrath-of-vengeance',
      sourceText: shortQuote(text('angel-of-death.fp.wrath-of-vengeance')),
      threshold: currentApl(T, ev.state, op),
    });
  });
}

// ---------------------------------------------------------------------------

function equipment(reg: HookRegistry, T: TeamHooks): void {
  // PURITY SEALS
  reg.on('onRollAttack', T.bind('angel-of-death.eq.purity-seals', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'angel-of-death.eq.purity-seals')) return;
    if (!T.mineKw(ev.ctx.attacker, 'ANGEL OF DEATH')) return;
    if (usedThisTP(ev.state, `aod.puritySeals:${T.player}`)) return;
    const seq = ev.state.sequence;
    const pool = seq?.kind === 'shoot' ? seq.attack : seq?.kind === 'fight' ? seq.attackerPool : undefined;
    if (!pool || pool.dice.filter((d) => d.state === 'fail').length < 2) return;
    useOncePerTP(ev.state, `aod.puritySeals:${T.player}`);
    ev.rerolls.push({
      id: 'aod.puritySeals',
      label: 'Purity Seals: discard one fail to retain another as a normal success',
      mode: 'fails',
      max: 1,
      player: T.player,
      sourceText: shortQuote(text('angel-of-death.eq.purity-seals')),
    });
  });

  // CHAPTER RELIQUARIES — "You can use the Wrath of Vengeance firefight ploy for 0CP if the
  // specified friendly operative has an Engage order."
  reg.on('onPloyUsed', T.bind('angel-of-death.eq.chapter-reliquaries', 30), (ev) => {
    if (ev.player !== T.player || ev.ployId !== 'angel-of-death.fp.wrath-of-vengeance') return;
    if (!hasEquipment(ev.state, T.player, 'angel-of-death.eq.chapter-reliquaries')) return;
    const counteracting = (ev.state.opState['counteract'] as { operativeId?: string } | undefined)?.operativeId;
    const op = counteracting ? ev.state.operatives[counteracting] : undefined;
    if (op?.order !== 'engage') return;
    const cp = DATA.firefightPloys.find((p) => p.id === 'angel-of-death.fp.wrath-of-vengeance')!.cp;
    ev.state.teams[T.player].cp += cp;
    log(ev.state, { kind: 'ploy', player: T.player, text: 'Chapter Reliquaries: Wrath of Vengeance costs 0CP' });
  });

  // TILTING SHIELDS — "your opponent cannot retain attack dice results of less than 6 as
  // critical successes during that sequence".
  reg.on('onWeaponRules', T.bind('angel-of-death.eq.tilting-shields', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'angel-of-death.eq.tilting-shields')) return;
    if (ev.operative.player === T.player) return; // it is the OPPONENT's weapon
    const foe = ev.target;
    if (!foe || !T.mineKw(foe, 'ANGEL OF DEATH')) return;
    if (ev.type !== 'melee') return;
    if (!usedThisTP(ev.state, `aod.tilting:${T.player}`) && !useOncePerTP(ev.state, `aod.tilting:${T.player}`)) return;
    ev.rules = ev.rules.filter((r) => r.id !== 'Lethal' && r.id !== 'Rending' && r.id !== 'Severe');
  });

  // AUSPEX — "enemy operatives within 8" of that friendly operative cannot be obscured".
  reg.on('onValidTarget', T.bind('angel-of-death.eq.auspex', 30), (ev) => {
    if (!hasEquipment(ev.state, T.player, 'angel-of-death.eq.auspex')) return;
    if (ev.attacker.player !== T.player || !T.kw(ev.attacker, 'ANGEL OF DEATH')) return;
    if (T.gap(ev.attacker, ev.target) > 8 + 1e-6) return;
    if (!usedThisTP(ev.state, `aod.auspex:${T.player}`) && !useOncePerTP(ev.state, `aod.auspex:${T.player}`)) return;
    ev.ignoreCoverTerrain = 'all';
  });
}

// ---------------------------------------------------------------------------

function actions(data: typeof DATA) {
  return [
    // OPTICS 1AP — ELIMINATOR SNIPER
    uniqueAction(data, 'angel-of-death.eliminator-sniper', 'angel-of-death.eliminator-sniper.act.optics', {
      check: (ctx, state, op) => notEngaged(ctx, state, op),
      perform: (_ctx, state, op) => {
        effect(state, {
          rule: 'aod.optics',
          source: { kind: 'ability', id: 'angel-of-death.eliminator-sniper.act.optics' },
          sourceText: 'Until the start of this operative’s next activation, whenever it’s shooting, enemy operatives cannot be obscured.',
          operativeId: op.id,
          player: op.player,
          expiry: { kind: 'endOfNextActivation', operativeId: op.id, armed: false },
        });
        log(state, { kind: 'action', player: op.player, text: `${op.letter}: OPTICS` });
        return { ok: true };
      },
    }),
  ];
}

/**
 * ASTARTES: "During each friendly ANGEL OF DEATH operative's activation, it can perform
 * either two Shoot actions or two Fight actions. If it's two Shoot actions, a bolt weapon
 * must be selected for at least one of them, and if it's a bolt sniper rifle or heavy bolter,
 * 1 additional AP must be spent for the second action if both actions are using that weapon."
 */
export const ASTARTES_SHOOT = 'Shoot (Astartes)';
export const ASTARTES_FIGHT = 'Fight (Astartes)';
const AOD_LAST_RANGED = 'aod.lastRanged';

registerAction({
  id: ASTARTES_SHOOT,
  name: 'Shoot (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'angel-of-death.rule.astartes')!.text,
  available: (ctx, _s, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes('ANGEL OF DEATH'),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'Astartes is the second Shoot action of an activation' };
    if (op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    const first = effectOn(state, op.id, AOD_LAST_RANGED)?.data?.['weapon'];
    const second = params.weaponName ?? '';
    if (!BOLT_WEAPON(String(first ?? '')) && !BOLT_WEAPON(second))
      return { ok: false, reason: 'a bolt weapon must be selected for at least one of them' };
    return getAction('Shoot')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    // "1 additional AP must be spent for the second action if both actions are using [a bolt
    //  sniper rifle or heavy bolter]".
    const first = String(effectOn(state, op.id, AOD_LAST_RANGED)?.data?.['weapon'] ?? '');
    const second = params.weaponName ?? '';
    const heavy = /bolt sniper rifle|heavy bolter/i;
    if (heavy.test(first) && first.toLowerCase() === second.toLowerCase()) op.apSpent += 1;
    return getAction('Shoot')!.perform(ctx, state, op, params);
  },
});

registerAction({
  id: ASTARTES_FIGHT,
  name: 'Fight (Astartes)',
  ap: 1,
  type: 'unique',
  sourceText: DATA.factionRules.find((r) => r.id === 'angel-of-death.rule.astartes')!.text,
  available: (ctx, _s, op) => (ctx.datacards.get(op.datacardId)?.keywords ?? []).includes('ANGEL OF DEATH'),
  check(ctx, state, op, params) {
    if (!op.actionsThisActivation.includes('Fight'))
      return { ok: false, reason: 'Astartes is the second Fight action of an activation' };
    if (op.actionsThisActivation.includes('Shoot'))
      return { ok: false, reason: 'either two Shoot actions or two Fight actions' };
    return getAction('Fight')!.check(ctx, state, op, params);
  },
  perform(ctx, state, op, params) {
    return getAction('Fight')!.perform(ctx, state, op, params);
  },
});

export const angelOfDeath = defineTeam({
  id: 'angel-of-death',
  rules: (reg, T) => {
    rules(reg, T);
    // Remember the ranged weapon used, so the Astartes second Shoot can be validated.
    reg.on('onCollectAttackDice', T.bind('angel-of-death.rule.astartes', 13), (ev) => {
      if (ev.ctx.type !== 'ranged' || !T.mineKw(ev.ctx.attacker, 'ANGEL OF DEATH')) return;
      const existing = effectOn(ev.state, ev.ctx.attacker.id, AOD_LAST_RANGED);
      if (existing) existing.data = { weapon: ev.ctx.weaponName };
      else
        effect(ev.state, {
          rule: AOD_LAST_RANGED,
          source: { kind: 'core', id: 'angel-of-death.rule.astartes' },
          operativeId: ev.ctx.attacker.id,
          player: T.player,
          data: { weapon: ev.ctx.weaponName },
          expiry: { kind: 'endOfActivation', operativeId: ev.ctx.attacker.id },
        });
    });
  },
  ploys,
  equipment,
  actions,
  aiHints: {
    roles: {
      'angel-of-death.space-marine-captain': 'leader',
      'angel-of-death.assault-intercessor-sergeant': 'leader',
      'angel-of-death.intercessor-sergeant': 'leader',
      'angel-of-death.eliminator-sniper': 'sniper',
      'angel-of-death.heavy-intercessor-gunner': 'gunner',
      'angel-of-death.intercessor-gunner': 'gunner',
      'angel-of-death.assault-intercessor-warrior': 'melee',
      'angel-of-death.assault-intercessor-grenadier': 'melee',
      'angel-of-death.intercessor-warrior': 'objective',
    },
    ployValue: {
      'angel-of-death.sp.combat-doctrine': 0.7,
      'angel-of-death.sp.and-they-shall-know-no-fear': 0.5,
      'angel-of-death.sp.adaptive-tactics': 0.3,
      'angel-of-death.sp.indomitus': 0.5,
      'angel-of-death.fp.adjust-doctrine': 0.3,
      'angel-of-death.fp.transhuman-physiology': 0.6,
      'angel-of-death.fp.shock-assault': 0.7,
      'angel-of-death.fp.wrath-of-vengeance': 0.5,
    },
    equipmentValue: {
      'angel-of-death.eq.purity-seals': 0.5,
      'angel-of-death.eq.chapter-reliquaries': 0.3,
      'angel-of-death.eq.tilting-shields': 0.4,
      'angel-of-death.eq.auspex': 0.5,
    },
  },
});

export default angelOfDeath;
