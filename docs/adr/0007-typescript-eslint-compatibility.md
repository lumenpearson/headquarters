# ADR-0007: TypeScript and ESLint compatibility

- Status: Accepted
- Date: 2026-08-15

## Context

On 2026-08-15 the package registry reported TypeScript 7.0.2, but `typescript-eslint@8.67.0`
declared support only for TypeScript versions below 6.1.0. Next.js 16.3.1 itself requires TypeScript
5.1 or newer.

## Decision

Pin TypeScript 6.0.3, the newest version inside the supported ESLint range. Keep strict compiler and
typed lint boundaries instead of suppressing parser warnings.

## Alternatives

Using TypeScript 7 outside the linter's declared range or removing TypeScript-aware linting would
make the release baseline less predictable.

## Consequences

The project will revisit TypeScript 7 after the Next/TypeScript ESLint stack officially supports it
and the full clean-build, unit, E2E and Tauri suite passes.
