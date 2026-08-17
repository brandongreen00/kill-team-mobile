/**
 * Terrain-only universal equipment: Razor Wire, Light Barricades (×2), Heavy Barricade and
 * Ladders (×2). Each is built as a real terrain feature with its measured footprint, so the
 * ordinary visibility / cover / movement rules apply to it.
 *
 * Footprints (owner-supplied, mm): razor wire 72 × 10 × 36; light barricade 50 × 10 × 25;
 * heavy barricade 40 × [15 assumed] × 45; ladder 20 × 5 × 95.
 */
import { equipmentText } from './text.ts';
import type { EquipmentItem, EquipmentModule } from './kit.ts';

export const RAZOR_WIRE_ID = 'eq.razorWire';
export const LIGHT_BARRICADES_ID = 'eq.lightBarricades';
export const HEAVY_BARRICADE_ID = 'eq.heavyBarricade';
export const LADDERS_ID = 'eq.ladders';

const TERRAIN_SET_UP: EquipmentItem['constraints'] = [
  'whollyWithinTerritory',
  'onKillzoneFloor',
  'moreThan2FromEquipmentTerrain',
  'moreThan2FromAccessPoints',
  'moreThan2FromAccessible',
];

export const razorWireEquipment: EquipmentModule = {
  id: RAZOR_WIRE_ID,
  name: 'Razor Wire',
  scope: 'universal',
  text: equipmentText(RAZOR_WIRE_ID),
  items: [
    {
      kind: 'terrain',
      featureKind: 'equipment.razorWire',
      footprintMm: { w: 72, d: 10, h: 36 },
      // "Razor wire is Exposed and Obstructing terrain." Obstructing is charged by movement.ts.
      types: ['Exposed', 'Obstructing'],
      constraints: TERRAIN_SET_UP,
    },
  ],
};

const lightBarricadeItem: EquipmentItem = {
  kind: 'terrain',
  featureKind: 'equipment.lightBarricade',
  footprintMm: { w: 50, d: 10, h: 25 },
  types: ['Light'],
  feet: true,
  constraints: TERRAIN_SET_UP,
};

export const lightBarricadesEquipment: EquipmentModule = {
  id: LIGHT_BARRICADES_ID,
  name: 'Light Barricades',
  scope: 'universal',
  text: equipmentText(LIGHT_BARRICADES_ID),
  items: [lightBarricadeItem, { ...lightBarricadeItem }],
};

export const heavyBarricadeEquipment: EquipmentModule = {
  id: HEAVY_BARRICADE_ID,
  name: 'Heavy Barricade',
  scope: 'universal',
  text: equipmentText(HEAVY_BARRICADE_ID),
  items: [
    {
      kind: 'terrain',
      featureKind: 'equipment.heavyBarricade',
      footprintMm: { w: 40, d: 15, h: 45 },
      types: ['Heavy'],
      constraints: [
        // "wholly within 4" of your drop zone" — not "within your territory".
        'whollyWithin4OfDropZone',
        'onKillzoneFloor',
        'moreThan2FromEquipmentTerrain',
        'moreThan2FromAccessPoints',
        'moreThan2FromAccessible',
      ],
    },
  ],
};

const ladderItem: EquipmentItem = {
  kind: 'terrain',
  // movement.ts keys the "treat the vertical distance as 1"" rule off this feature kind.
  featureKind: 'equipment.ladder',
  footprintMm: { w: 20, d: 5, h: 95 },
  types: ['Insignificant', 'Exposed'],
  constraints: [
    'whollyWithinTerritory',
    'uprightAgainstTerrain2Tall',
    'moreThan2FromEquipmentTerrain',
    'moreThan1FromDoorsAndAccessPoints',
  ],
};

export const laddersEquipment: EquipmentModule = {
  id: LADDERS_ID,
  name: 'Ladders',
  scope: 'universal',
  text: equipmentText(LADDERS_ID),
  items: [ladderItem, { ...ladderItem }],
};
