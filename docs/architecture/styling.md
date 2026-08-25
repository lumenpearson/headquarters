# Styling: terminal tokens, Tailwind and shadcn/ui

Three systems coexist deliberately. This document says which one owns what, and
why the seams are where they are.

## Ownership

| Concern                                    | Owner                                                            |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Portal and primitive colour, spacing, type | `packages/ui/src/styles/tokens.css` — dark-only, no variants     |
| Operational shell colour and its 8 themes  | `--ops-*` on `.ops-shell` in `apps/hq/src/styles/operations.css` |
| Operational shell, screens, scenes         | `apps/hq/src/styles/*.css` plus Tailwind utilities               |
| Scene-agnostic interactive primitives      | `packages/ui/src/primitives/` (`Terminal*`, wrapping Base UI)    |
| Richer generated components                | `packages/ui/src/shadcn/` (shadcn/ui, `base-maia` preset)        |

The terminal design system owns the product's appearance. shadcn/ui supplies
components, not the look.

## Tailwind v4

Configured in `apps/hq/postcss.config.mjs` (only `@tailwindcss/postcss`; v4 does
its own nesting and prefixing through Lightning CSS, so adding `postcss-nested`
or `autoprefixer` alongside it causes divergence) and entered from
`apps/hq/app/globals.css`.

**Preflight is not imported.** `globals.css` pulls
`tailwindcss/theme.css` and `tailwindcss/utilities.css` separately rather than
the combined `@import "tailwindcss"`. The app carries roughly 11 000 lines of
hand-written CSS plus its own reset that assume unreset defaults; Tailwind's
preflight would silently restyle every existing screen. The one piece the
utilities genuinely need — a default `border-style`, without which the `border`
utility renders nothing — is reproduced in the base layer.

Automatic source detection walks up from `globals.css` and never reaches the
workspace packages, so `@source` directives add `packages/ui/src` and
`packages/layout-engine/src`. Without them the classes used by the `Terminal*`
and shadcn components are pruned from the build.

### Two token namespaces, deliberately

`@theme inline` maps the terminal tokens under an `hq-` prefix
(`bg-hq-panel-1`, `text-hq-text-1`, `border-hq-line-1`, `bg-hq-accent`, …).
`inline` means each utility emits `var(--token)` rather than a copied value, so a
runtime theme or density change moves the utilities and the hand-written CSS
together.

The shadcn preset keeps its own unprefixed vocabulary (`bg-background`,
`bg-primary`, `border-border`, …). Its dark variants never apply: nothing in
the app sets the `dark` class the preset’s `@custom-variant` keys off — the
body carries `terminal-theme` — so a shadcn component arrives in the preset’s
light palette regardless of the active terminal theme.

The prefix is not decoration. Both systems define `--accent`, and they mean
different things: `#ff3d00` is the product's signature colour, while the
preset's is a near-white hover surface. Since the preset's `:root` block is
written into `globals.css`, which loads after `tokens.css`, an unprefixed
mapping silently destroyed the signature colour. The preset's value is therefore
renamed to `--ui-accent` / `--ui-accent-foreground`, and `--color-accent` maps to
it, so `bg-accent` still behaves as shadcn components expect.

`--font-sans`, `--font-mono`, `--radius-1` and `--radius-2` are deliberately
absent from `@theme`: those names sit inside Tailwind's own `--font-*` and
`--radius-*` namespaces, so mapping them would be a self-reference. `tokens.css`
declares them unlayered, which outranks the theme layer, so `font-sans` and
`font-mono` already resolve to the terminal stacks.

### Fonts

The preset wires Geist through `next/font/google` and points `--font-mono` at
it. That is **not** adopted. The terminal type stacks are part of the product's
look, and `next/font/google` fetches at build time, which conflicts with the
offline-first desktop target. Typography stays owned by `tokens.css`.

### How a setting reaches the document

Personalization does not write CSS. `apps/hq/src/application/personalization/presentation.ts`
holds one table from setting id to either a `data-*` attribute or an `--ops-*`
custom property on the shell root, and `OperationsShell` applies the resolved
pair. Adding a setting means adding a binding there, or listing the setting in
`settingsWithoutPresentation` with the consumer that reads it instead;
`presentation.test.ts` fails on any definition that is neither.

A default is the absence of a rule, not a rule carrying a neutral value. A
`letter-spacing`, `font-weight` or `min-height` declaration written at the shell
root outranks every lower-specificity value the design already set, and
`var(--x)` with no `--x` resolves to `unset` rather than to the value
underneath. So a custom property is emitted only once an operator has moved it
off the definition default, and a setting whose neutral value would still be a
declaration — `typography.weight`, `typography.accentWeight`,
`sizes.controlHeight` — travels as an attribute the stylesheet keys off
instead. This is also why a new rule belongs at its original declaration site:
appended at the end of a six-thousand-line stylesheet it outranks every
responsive and per-screen variant above it.

## Adding a shadcn component

```powershell
pnpm ui:add button
```

This runs the shadcn CLI and then `scripts/sync-shadcn.mjs`.

The two-step exists because of the UI boundary. `scripts/check-ui-boundary.mjs`
fails the build if any file outside `packages/ui` imports `@base-ui/react`
directly or uses a raw `<button>/<input>/<select>/<textarea>` — and every shadcn
component does both. The components must therefore live in `packages/ui`, which
is the check's only exempt tree.

The CLI cannot write there: it resolves its `ui`/`lib`/`hooks` aliases through
the host package's own exports, so it can only target `apps/hq`. So it writes to
`apps/hq/src/components/ui` as a staging directory, and the sync script moves the
result into `packages/ui/src/shadcn`, rewrites `@/…` aliases to relative
specifiers, appends the re-export, and deletes the staging directory.

The alias rewrite is not cosmetic: an `@/…` specifier would survive into
`packages/ui/dist` and fail to resolve for every consumer, because only
`apps/hq/tsconfig.json` knows about `@/*`.

Consume from the package entry point:

```ts
import { Button } from '@gremuchaya/ui/shadcn';
```

Never re-implement one of these components outside `packages/ui`, and never
weaken `check-ui-boundary.mjs` to admit a library — move the library instead.

## Which component set to reach for

- **`Terminal*` primitives** for the operational shell. They carry the terminal
  design language and are what the existing screens use.
- **shadcn/ui** where a genuinely richer control is needed and no `Terminal*`
  wrapper exists. Its components arrive with the preset's palette, which is
  separate from the terminal tokens, so check them against the dark shell before
  shipping.

If a control is missing, adding a `Terminal*` wrapper in
`packages/ui/src/primitives/` is usually the better answer than reaching for a
second design language.

## Not claimed

The existing hand-written CSS has **not** been migrated to Tailwind utilities.
Tailwind is wired up, tokens are bridged, and utilities are available; converting
`hq.css`, `terminal.css`, `operations.css`, `edit.css`, `startup.css`,
`keybinds.css` and `interaction.css` is a separate, screen-by-screen migration
that needs visual verification per screen. Nothing in this change
alters how any existing screen renders — that was the constraint it was built
under, and the build output was checked for it (`--accent` still resolves to
`#ff3d00`, no preflight rules in the emitted CSS).

No screen imports from `@gremuchaya/ui/shadcn` yet — `button` is the only
component the preset has generated — and no `hq-` utility appears in a
component. The bridge exists so the first conversion does not have to build it.
