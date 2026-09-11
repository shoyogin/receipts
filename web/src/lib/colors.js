/* Class hues are CSS variables, not literals, so they follow the light/dark
   switch with no React state involved: an inline `background: var(--color-cls-3)`
   just re-resolves when the theme attribute changes.

   The order is fixed and validated for colour-blind separation in both themes
   (worst adjacent ΔE 9.1 light, 8.4 dark). Colour follows the class INDEX,
   never its rank, so a class keeps its hue for the life of the dataset and
   filtering never repaints the classes that remain.

   Past eight classes the hues repeat. That is fine: the class name is printed
   on every box, slice and table row, so identity never rests on colour alone. */
export const CLASS_SLOTS = 8

const slot = (i) => (((i % CLASS_SLOTS) + CLASS_SLOTS) % CLASS_SLOTS) + 1

export const classColor = (i) => `var(--color-cls-${slot(i)})`
export const classInk = (i) => `var(--color-cls-ink-${slot(i)})`

// "Other" slices and unfilled tracks — present, but never mistaken for data.
export const GREY = 'var(--color-neutral)'
