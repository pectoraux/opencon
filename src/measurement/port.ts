/**
 * Measurement boundary — measurement provider integration port.
 *
 * Architecture ref: spec/architecture.md §13, §18 (`/measurement` —
 * "measurement provider integrations; semantics remain in /outcomes"),
 * architecture-lock.md §14 (measurement adapters provide facts;
 * `/outcomes` retains semantic authority).
 *
 * Domain code (`/outcomes`) depends on this neutral port, never on a
 * concrete provider in `src/measurement/providers/`.
 */

export interface MeasurementInput {
  readonly subject: string;
  readonly scope?: Readonly<Record<string, unknown>>;
}

export interface MeasurementResult {
  readonly subject: string;
  readonly value: number;
  readonly confidence: number;
  readonly provenance: string;
}

export interface MeasurementPort {
  readonly boundary: "measurement";
  readonly readiness: "skeleton";
  measure(input: MeasurementInput): Promise<MeasurementResult>;
}
