import { it } from 'vitest';
import { teamData } from '../../src/teams/data.ts';
import { defaultRoster, validateRosterFor, entryId } from '../../src/teams/selection.ts';
import { selectionEntries } from '../../src/teams/data.ts';

it('dump', () => {
  const DATA = teamData('blooded');
  const picks = defaultRoster(DATA);
  const v = validateRosterFor(DATA, picks);
  const entries = selectionEntries(DATA);
  console.log('PICKS', picks.length);
  picks.forEach((p, i) => {
    console.log(i, p.datacardId, p.entryId, JSON.stringify(p.loadoutIds), '=>', JSON.stringify(v.weapons[i]));
  });
  console.log('ERRORS', v.errors);
  console.log('--- entries ---');
  entries.forEach((e, i) => {
    console.log(i, entryId(DATA, i), '| role=', e.role, '| card=', e.datacardId, '| fn=', e.footnoteGroup, '| cost=', e.selectionCost, '| group=', e.group, '| loadouts=', JSON.stringify(e.loadouts));
  });
  console.log('--- constraints ---', JSON.stringify(DATA.selection.constraints));
  console.log('--- footnotes ---', JSON.stringify(DATA.selection.footnotes));
});
