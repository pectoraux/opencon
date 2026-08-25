/**
 * Payments boundary — payment provider integration port.
 *
 * Architecture ref: spec/architecture.md §18 (`/payments` — "payment
 * provider integrations; settlement semantics remain in /settlement"),
 * architecture-lock.md §14 (payment adapters provide transaction facts;
 * `/settlement` retains semantic authority).
 *
 * Domain code (`/settlement`) depends on this neutral port, never on a
 * concrete provider in `src/payments/providers/`.
 */

export interface PayoutInput {
  readonly amount: number;
  readonly currency: string;
  readonly reference: string;
}

export interface PayoutResult {
  readonly reference: string;
  readonly externalReference: string;
  readonly status: "paid" | "pending" | "failed";
}

export interface PaymentPort {
  readonly boundary: "payments";
  readonly readiness: "skeleton";
  payout(input: PayoutInput): Promise<PayoutResult>;
}
