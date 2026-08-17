/** Printed universal-equipment text, loaded from `data/equipment/universal.json`. */
import universal from '../../../data/equipment/universal.json';

export interface PrintedEquipment {
  id: string;
  name: string;
  count: number;
  text: string;
  weapons?: { id: string; name: string; atk: number; hit: number; dmgN: number; dmgC: number; rules: string }[];
}

const data = universal as unknown as { equipment: PrintedEquipment[]; footprintProvenance: Record<string, string> };

export const UNIVERSAL_EQUIPMENT_TEXT: PrintedEquipment[] = data.equipment;
export const FOOTPRINT_PROVENANCE = data.footprintProvenance;

export function equipmentText(id: string): string {
  const found = UNIVERSAL_EQUIPMENT_TEXT.find((e) => e.id === id);
  if (!found) throw new Error(`No printed text for equipment '${id}' — data/equipment/universal.json disagrees.`);
  return found.text;
}

export function equipmentName(id: string): string {
  return UNIVERSAL_EQUIPMENT_TEXT.find((e) => e.id === id)?.name ?? id;
}

export function grenadeProfile(weaponId: 'frag' | 'krak') {
  const eq = UNIVERSAL_EQUIPMENT_TEXT.find((e) => e.id === 'eq.explosiveGrenades');
  const w = eq?.weapons?.find((x) => x.id === weaponId);
  if (!w) throw new Error(`No printed profile for the ${weaponId} grenade.`);
  return w;
}
