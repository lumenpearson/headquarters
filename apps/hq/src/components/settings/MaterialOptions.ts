import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';

/**
 * The value a `material` setting holds when no material is chosen.
 *
 * The empty string is what the schema validates as "unset", but a select
 * cannot offer an empty value as a distinct row, so the picker carries this
 * sentinel and the component maps it back.
 */
export const unsetMaterialOption = '__unset__';

export interface MaterialOption {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * Builds the rows a `material` picker offers.
 *
 * Kept out of the component so the rules that matter -- what is offered, and
 * what happens to a reference whose material is gone -- can be tested without
 * a catalogue, a bridge, or a DOM.
 */
export function materialOptionsFor(
  materials: readonly MaterialEntry[],
  accept: readonly string[],
  chosen: string,
): readonly MaterialOption[] {
  const offered = materials.filter((material) => {
    const mimeType = material.mimeType.toLocaleLowerCase('en-US');
    return accept.some((prefix) => mimeType.startsWith(prefix.toLocaleLowerCase('en-US')));
  });

  const options: MaterialOption[] = [
    { value: unsetMaterialOption, label: '[НЕ ВЫБРАН]' },
    ...offered.map((material) => ({
      value: material.materialId,
      label: `[ФАЙЛ] ${material.displayName}`,
    })),
  ];

  // A reference whose material the catalogue no longer lists still has to be
  // visible. Dropping it would show "not chosen" while the setting holds a
  // reference, and the operator would have no way to tell a cleared setting
  // from a broken one.
  if (chosen !== '' && !offered.some((material) => material.materialId === chosen)) {
    options.push({
      value: chosen,
      // Twelve characters, matching how VideoScreen already renders a missing
      // camera material -- the same situation should not look like two.
      label: `[ОТСУТСТВУЕТ] ${chosen.slice(0, 12)}`,
      disabled: true,
    });
  }

  return options;
}
