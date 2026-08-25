# Dependency Graph

## Foundation

```text
NET-W001
├── NET-W002
└── NET-W003
```

## Protocol core

```text
NET-W002 + NET-W003 → NET-W004
NET-W004 + NET-W003 → NET-W005
NET-W005 + NET-W004 → NET-W006
NET-W005 + NET-W006 → NET-W007
NET-W005 + NET-W006 + NET-W007 → NET-W008
```

## Trust

```text
NET-W002 + NET-W005 + NET-W007 + NET-W008
        ↓
     NET-W009
        ↓
     NET-W010
```

## Farmable / helpfulness

```text
NET-W004 + NET-W005 + NET-W008 → NET-W011
NET-W005 + NET-W006 + NET-W011 → NET-W012
NET-W009 + NET-W012 → NET-W013
NET-W008 + NET-W012 + NET-W013 → NET-W014
```

## Creator

```text
NET-W002 + NET-W007 → NET-W015
NET-W006 + NET-W007 + NET-W015 → NET-W016
NET-W016 + NET-W011 + NET-W014 → NET-W017
NET-W017 + NET-W005 → NET-W018
```

## Advertising

```text
NET-W002 + NET-W011 → NET-W019
NET-W008 + NET-W019 → NET-W020
NET-W006 + NET-W007 + NET-W009 + NET-W019 → NET-W021
NET-W005 + NET-W006 → NET-W022
NET-W019 + NET-W022 → NET-W023
```

## Demand

```text
NET-W002 + NET-W008 → NET-W024
NET-W024 + NET-W008 → NET-W025
NET-W025 → NET-W026
NET-W006 + NET-W026 → NET-W027
NET-W008 + NET-W024 + NET-W027 + NET-W020 → NET-W028
```

## Decentralization

```text
NET-W005 + NET-W007 + NET-W008 → NET-W029
NET-W008 + NET-W029 → NET-W030
NET-W007 + NET-W029 → NET-W031
NET-W010 + NET-W029 + NET-W030 → NET-W032
```

## End-to-end convergence

```text
NET-W014 + NET-W018 + NET-W023 + NET-W028 → NET-W033
NET-W020 + NET-W021 + NET-W022 + NET-W023 + NET-W033 → NET-W034
NET-W018 + NET-W034 → NET-W035
NET-W028 + NET-W033 → NET-W036
```

## Parallelization

After NET-W001..003:

- core protocol work can proceed in parallel with creator preparation and adapter contracts;
- fraud work follows evidence/reputation primitives;
- demand work can progress in parallel with advertising after credits/evidence exist;
- decentralization deliberately follows validated centralized economic semantics.

## Dependency invariants

1. No work item may depend on undefined work.
2. No circular dependencies.
3. Economic settlement depends on evidence.
4. Reputation depends on evidence.
5. Benefit allocation depends on verified economic value.
6. Decentralization depends on stable off-chain semantics rather than defining them.
7. Provider-specific integrations remain adapters.
