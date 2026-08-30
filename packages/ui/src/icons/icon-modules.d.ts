/**
 * Types for the one thing lucide-react and `@tabler/icons-react` do not
 * publish through their typed barrel: a single icon's raw node data.
 *
 * Both ship every icon's shape twice per icon -- as a component
 * (`createLucideIcon`/`createReactComponent`, typed, but hard-codes
 * `width`/`height`/`stroke` on the outer `<svg>` with no prop that removes
 * rather than recolours them) and as the `__iconNode` tuple array that
 * component is built from (untyped past this file, because neither package's
 * barrel re-exports it -- only the bulk `icons` map does, and importing that
 * pulls every icon in the set, the ~17.8 MB the adapters here exist to avoid).
 * `lucide.ts` and `tabler.ts` import `__iconNode` directly from each icon's
 * own module instead, which is what lets `TerminalIcon` render the shape
 * without a library ever writing those attributes itself.
 *
 * The wildcard covers every icon in each package rather than the handful this
 * repository currently draws on: an adapter naming one that does not exist
 * fails to resolve at build and at test time regardless, and a second
 * hand-maintained list of exact paths here would only be one more place for
 * that same set to drift.
 */
declare module 'lucide-react/dist/esm/icons/*.mjs' {
  const iconNode: readonly (readonly [string, Readonly<Record<string, string | number>>])[];
  export { iconNode as __iconNode };
  export default iconNode;
}

declare module '@tabler/icons-react/dist/esm/icons/*.mjs' {
  const iconNode: readonly (readonly [string, Readonly<Record<string, string | number>>])[];
  export { iconNode as __iconNode };
  export default iconNode;
}
