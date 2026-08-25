# ADR-0004: Information state machines

- Status: Accepted
- Date: 2026-08-15

## Context

Satellite, communication, security, media and explorer mounts have mutually exclusive states that
must remain deterministic under cues and developer overrides.

## Decision

Model each machine as a discriminated union. Satellite, communication and security carry a pure
exhaustive transition reducer; media and explorer-mount state are unions only, because nothing
drives them through events yet. Do not add XState while these transitions remain small and
synchronous.

## Alternatives

Independent booleans allow impossible combinations. A state-machine framework would add runtime and
learning cost without solving a present complexity problem.

## Consequences

Transitions are unit-testable in isolation. No screen, store or developer form drives them yet —
the machines are defined and tested ahead of the surfaces that will expose their events.
