/**
 * Rare weapon rules — the definition a player is shown must be the one THEIR kill team prints.
 *
 * `data/teams/_rare-weapon-rules.json` stores one definition per rule id, resolved by the
 * normaliser from whichever team it found first. Teams genuinely differ, so the module layer
 * resolves each rule against its own team's printed source (docs/DECISIONS.md D-025).
 */
import { describe, expect, it } from 'vitest';
import { teamData } from '../src/teams/data.ts';
import { rareRuleTextFor } from '../src/teams/helpers.ts';
import { rareWeaponRules } from '../src/core/weaponRules.ts';
import '../src/teams/index.ts';

describe('a rare rule is quoted as the team that uses it prints it', () => {
  it('Anti-PSYKER: the Novitiates add a Dmg bump, the Celestian Insidiants do not (D-025)', () => {
    // Novitiate Condemnor datacard ability, footnoted `Anti-PSYKER*` on its weapons.
    const novitiates = rareRuleTextFor(teamData('novitiates'), 'AntiPSYKER');
    expect(novitiates).toContain('add 1 to both Dmg stats of this weapon');
    expect(novitiates).toContain('Lethal 5+');

    // Celestian Insidiants' own footnote inside the "Weapons of the Witch Hunters" faction rule.
    const celestian = rareRuleTextFor(teamData('celestian-insidiants'), 'AntiPSYKER');
    expect(celestian).toContain('Lethal 5+');
    expect(celestian).not.toContain('add 1 to both Dmg stats');

    // They are genuinely different printed rules, not a scraping artefact.
    expect(novitiates).not.toEqual(celestian);
  });

  it('Detonate names each team’s own marker', () => {
    expect(rareRuleTextFor(teamData('death-korps'), 'Detonate')).toContain('Mine marker');
    expect(rareRuleTextFor(teamData('phobos-strike-team'), 'Detonate')).toContain('Explosives marker');
  });

  it('the registry keeps every using team’s wording, so a tooltip can pick the right one', () => {
    const anti = rareWeaponRules().find((r) => r.id === 'AntiPSYKER')!;
    expect(anti.teams).toEqual(expect.arrayContaining(['novitiates', 'celestian-insidiants']));
    expect(anti.byTeam['novitiates']).toContain('add 1 to both Dmg stats');
    expect(anti.byTeam['celestian-insidiants']).not.toContain('add 1 to both Dmg stats');
  });

  it('a rule only one team prints still resolves', () => {
    expect(rareRuleTextFor(teamData('plague-marines'), 'Poison')).toContain('Poison token');
    expect(rareRuleTextFor(teamData('hierotek-circle'), 'Magnify')).toContain('Ceaseless');
  });
});
