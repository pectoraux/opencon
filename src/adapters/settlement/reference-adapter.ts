/**
 * NET-W030 — the reference external settlement provider adapter
 * (ADAPTER-008; issue #61 scope 2).
 *
 * Provider-neutral reference implementation of the external
 * settlement adapter contract: it normalizes the reference provider's
 * transaction-notification payload into the NEUTRAL protocol facts.
 * It binds to NO payment-network SDK (architecture-lock §14.24 —
 * provider vocabulary never crosses into domain authorities). Real
 * payment-network integrations implement the same neutral contract
 * with their own vendor tier under `src/adapters/settlement/`.
 *
 * The adapter performs NO I/O, NO mutation and NO authentication:
 * normalization is a pure function of the payload; the trust
 * envelope is verified DOWNSTREAM by the /settlement authority
 * against SecretProvider-resolved material (the W023 discipline).
 * The adapter re-asserts its own provider identity so a submission
 * addressed to another provider can never normalize here
 * (provider-identity spoofing guard).
 *
 * ADAPTER-TIER CONTRACT MIRRORING: this file deliberately does NOT
 * import `src/settlement/port.ts` (the tier matrix forbids
 * adapter→domain imports). The neutral contract is declared in the
 * consuming domain's port and implemented here STRUCTURALLY — the
 * composition root is the ONLY join, and `tsc` enforces the
 * structural compatibility at the wiring site forever (the W029
 * composition-root crypto precedent, applied to the adapter tier).
 *
 * Adapter tier: imports builtin modules + local modules only; no
 * domain imports (tier matrix).
 */

/** The reference external settlement provider id. */
export const EXTERNAL_SETTLEMENT_REFERENCE_PROVIDER_ID = "reference" as const;

/** The reference adapter version. */
export const EXTERNAL_SETTLEMENT_REFERENCE_ADAPTER_VERSION = "1.0.0" as const;

/**
 * The reference provider's trust-envelope shape (structurally
 * identical to the neutral ExternalSettlementIntegrityBlock declared
 * in the /settlement port).
 */
export interface ReferenceSettlementIntegrityBlock {
  readonly algorithm: string;
  readonly signature: string;
  readonly signedAt: string;
}

/**
 * The reference provider's normalized transaction facts
 * (structurally identical to the neutral
 * ExternalSettlementTransactionFacts declared in the /settlement
 * port). The `reference/v1` notification payload grammar:
 *
 * ```json
 * {
 *   "externalId": "ext-txn-...",
 *   "internalTransactionId": "...",
 *   "reportedAmount": 100,
 *   "reportedUnit": "value" | "credits" | "cash",
 *   "observedAt": "2024-01-01T00:00:00.000Z",
 *   "correctionOf": null | "fact-id",
 *   "integrity": { "algorithm": "hmac-sha256/v1", "signature": "<hex>",
 *                  "signedAt": "2024-01-01T00:00:00.000Z" }
 * }
 * ```
 */
export interface ReferenceSettlementTransactionFacts {
  readonly provider: string;
  readonly providerVersion: string;
  readonly externalId: string;
  readonly internalTransactionId: string;
  readonly reportedAmount: number;
  readonly reportedUnit: string;
  readonly observedAt: string;
  readonly correctionOf: string | null;
  readonly integrity: ReferenceSettlementIntegrityBlock;
}

/** The raw reference submission routed by provider id. */
export interface RawReferenceSettlementSubmission {
  readonly providerId: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ExternalSettlementReferenceAdapterOptions {
  /** Adapter version override (defaults to the reference version). */
  readonly version?: string;
  /**
   * The provider identity this adapter answers to. Defaults to the
   * reference provider id; a concrete network integration overrides
   * it with the network's registered provider identity.
   */
  readonly provider?: string;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export class ExternalSettlementReferenceAdapter {
  public readonly info: {
    readonly kind: "external_settlement";
    readonly provider: string;
    readonly version: string;
  };

  public constructor(options: ExternalSettlementReferenceAdapterOptions = {}) {
    this.info = Object.freeze({
      kind: "external_settlement",
      provider: options.provider ?? EXTERNAL_SETTLEMENT_REFERENCE_PROVIDER_ID,
      version: options.version ?? EXTERNAL_SETTLEMENT_REFERENCE_ADAPTER_VERSION,
    });
  }

  public async initialize(): Promise<void> {}

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  public async normalizeTransaction(
    submission: RawReferenceSettlementSubmission,
  ): Promise<ReferenceSettlementTransactionFacts> {
    // The service routes by provider id; the adapter re-asserts its
    // own identity so a submission addressed to another provider can
    // never normalize here (provider identity spoofing guard — the
    // W023 reference-adapter discipline).
    if (submission.providerId !== this.info.provider) {
      throw new Error(
        `the reference external settlement adapter owns provider id ${this.info.provider} and cannot normalize a submission addressed to ${submission.providerId}`,
      );
    }
    const payload = submission.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("the reference external settlement notification payload must be a JSON object");
    }
    if (!nonEmptyString(payload.externalId)) {
      throw new Error('the reference external settlement notification requires a non-empty "externalId"');
    }
    if (!nonEmptyString(payload.internalTransactionId)) {
      throw new Error(
        'the reference external settlement notification requires a non-empty "internalTransactionId"',
      );
    }
    if (typeof payload.reportedAmount !== "number" || !Number.isFinite(payload.reportedAmount)) {
      throw new Error('the reference external settlement notification requires a numeric "reportedAmount"');
    }
    if (!nonEmptyString(payload.reportedUnit)) {
      throw new Error('the reference external settlement notification requires a non-empty "reportedUnit"');
    }
    if (!nonEmptyString(payload.observedAt)) {
      throw new Error('the reference external settlement notification requires an "observedAt" timestamp');
    }
    const correctionOf =
      payload.correctionOf === null || payload.correctionOf === undefined
        ? null
        : payload.correctionOf;
    if (correctionOf !== null && !nonEmptyString(correctionOf)) {
      throw new Error('the reference external settlement notification "correctionOf" must be null or a non-empty string');
    }
    const integrity = payload.integrity;
    if (integrity === null || integrity === undefined || typeof integrity !== "object") {
      throw new Error('the reference external settlement notification requires an "integrity" envelope object');
    }
    const envelope = integrity as Record<string, unknown>;
    if (!nonEmptyString(envelope.algorithm) || !nonEmptyString(envelope.signature)) {
      throw new Error('the reference external settlement notification requires integrity algorithm + signature');
    }
    if (!nonEmptyString(envelope.signedAt)) {
      throw new Error('the reference external settlement notification requires an integrity "signedAt" timestamp');
    }
    return {
      provider: this.info.provider,
      providerVersion: this.info.version,
      externalId: payload.externalId,
      internalTransactionId: payload.internalTransactionId,
      reportedAmount: payload.reportedAmount,
      reportedUnit: payload.reportedUnit,
      observedAt: payload.observedAt,
      correctionOf,
      integrity: {
        algorithm: envelope.algorithm,
        signature: envelope.signature,
        signedAt: envelope.signedAt,
      },
    };
  }
}
