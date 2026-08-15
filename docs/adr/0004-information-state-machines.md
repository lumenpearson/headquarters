# Context

Satellite, communication, security, media and explorer mounts have mutually exclusive states that
must remain deterministic under cues and developer overrides.

# Decision

Model each machine as a discriminated union plus a pure exhaustive transition reducer. Do not add
XState while these transitions remain small and synchronous.

# Alternatives

Independent booleans allow impossible combinations. A state-machine framework would add runtime and
learning cost without solving a present complexity problem.

# Consequences

Transitions are unit-testable and developer forms can expose only valid events/payloads.
