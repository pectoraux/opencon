/**
 * NET-W023 — the reference OpenRTB / supply-chain provider adapter
 * (ADAPTER-001..002; issue #46 scope 2).
 *
 * Provider-neutral reference implementation of the OpenRTB adapter
 * contract: it normalizes the reference vendor bid-request shape and
 * the ads.txt / app-ads.txt / sellers.json file grammars into the
 * neutral protocol facts. It binds to NO vendor SDK
 * (architecture-lock §14.24 — provider vocabulary never crosses into
 * domain authorities). Real exchange integrations implement the same
 * neutral contract with their own vendor tier under
 * `src/adapters/openrtb/`.
 *
 * The adapter performs NO I/O and NO mutation: normalization is a
 * pure function of the payload. Credentials and transport concerns
 * (real exchange authentication) are composition-time inputs that
 * live with the concrete integration, not with this reference.
 *
 * Adapter tier: imports core contracts + the neutral port + the local
 * vendor-tier modules only; no domain imports (tier matrix).
 */

import type {
  OpenRtbProviderAdapter,
  OpenRtbRequestNormalization,
  RawOpenRtbRequestSubmission,
  RawSellerAuthorizationSubmission,
  SellerAuthorizationNormalization,
} from "../port.ts";
import { normalizeVendorRequest } from "./vendor-request.ts";
import { normalizeSellerAuthorizationFile } from "./supply-chain-files.ts";

/** The reference OpenRTB provider id. */
export const OPENRTB_REFERENCE_PROVIDER_ID = "openrtb-reference" as const;

/** The reference adapter version. */
export const OPENRTB_REFERENCE_ADAPTER_VERSION = "1.0.0" as const;

export interface OpenRtbReferenceAdapterOptions {
  /** Adapter version override (defaults to the reference version). */
  readonly version?: string;
  /**
   * The provider identity this adapter answers to. Defaults to the
   * reference provider id; a concrete exchange integration overrides
   * it with the exchange's registered provider identity.
   */
  readonly provider?: string;
}

export class OpenRtbReferenceAdapter implements OpenRtbProviderAdapter {
  public readonly info: {
    readonly kind: "openrtb";
    readonly provider: string;
    readonly version: string;
  };

  public constructor(options: OpenRtbReferenceAdapterOptions = {}) {
    this.info = Object.freeze({
      kind: "openrtb",
      provider: options.provider ?? OPENRTB_REFERENCE_PROVIDER_ID,
      version: options.version ?? OPENRTB_REFERENCE_ADAPTER_VERSION,
    });
  }

  public async initialize(): Promise<void> {}

  public async healthCheck(): Promise<{ ok: boolean; detail?: string }> {
    return { ok: true };
  }

  public async normalizeRequest(
    submission: RawOpenRtbRequestSubmission,
  ): Promise<OpenRtbRequestNormalization> {
    // The ingress routes by provider id; the adapter re-asserts its
    // own identity so a submission addressed to another provider can
    // never be normalized here (provider identity spoofing guard).
    if (submission.providerId !== this.info.provider) {
      throw new Error(
        `the reference OpenRTB adapter owns provider id ${this.info.provider} and cannot normalize a submission addressed to ${submission.providerId}`,
      );
    }
    return normalizeVendorRequest({
      providerId: this.info.provider,
      payload: submission.payload,
    });
  }

  public async normalizeSellerAuthorization(
    submission: RawSellerAuthorizationSubmission,
  ): Promise<SellerAuthorizationNormalization> {
    if (submission.providerId !== this.info.provider) {
      throw new Error(
        `the reference OpenRTB adapter owns provider id ${this.info.provider} and cannot normalize a submission addressed to ${submission.providerId}`,
      );
    }
    return normalizeSellerAuthorizationFile(submission);
  }
}
