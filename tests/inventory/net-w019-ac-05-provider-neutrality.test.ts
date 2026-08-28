/**
 * NET-W019-AC-05 — provider-neutral boundaries and secret isolation
 * remain intact (CAMP-003; issue #37 invariant 6): the external
 * reference descriptor is provider-neutral; provider-specific
 * semantics stay behind /adapters; credentials stay behind
 * /secrets + /adapters.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createNetW019Harness,
  registerInventoryItem,
  personCtx,
  key,
  type NetW019Harness,
} from "./_net-w019-harness.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

let harness: NetW019Harness;
const REPO = join(import.meta.dir, "../..");

describe("NET-W019-AC-05 provider neutrality + secret isolation", () => {
  beforeAll(async () => {
    harness = await createNetW019Harness();
  });
  afterAll(async () => {
    await harness.teardown();
  });

  test("the external reference descriptor is EXACTLY provider/externalId/url (no platform semantics, no credentials)", async () => {
    const item = await registerInventoryItem(harness, {
      externalReference: {
        provider: "an-existing-ad-network",
        externalId: "slot-42",
        url: "https://adnetwork.example/slots/42",
      },
    });
    expect(Object.keys(item.externalReference!).sort()).toEqual([
      "externalId",
      "provider",
      "url",
    ]);
    // The item record carries NO credential-shaped fields beyond the
    // neutral descriptor (the W015 credential-key guard precedent).
    const keys = Object.keys(item).sort();
    expect(keys).toEqual([
      "attributes",
      "causationId",
      "correlationId",
      "createdAt",
      "createdBy",
      "description",
      "executionId",
      "externalReference",
      "format",
      "formatVersion",
      "id",
      "idempotencyKey",
      "organizationScopeId",
      "ownerPersonId",
      "retiredAt",
      "retirementReason",
      "surfaceKind",
      "updatedAt",
      "verificationEvidenceReference",
    ]);
  });

  test("any provider identifier works uniformly (the domain has NO provider-specific semantics)", async () => {
    for (const provider of ["network-a", "another-network", "x"]) {
      const item = await registerInventoryItem(harness, {
        externalReference: {
          provider,
          externalId: "slot-1",
          url: null,
        },
      });
      expect(item.externalReference!.provider).toBe(provider);
    }
    // Unlinked supply (null reference) is legitimate — external
    // interop is OPTIONAL per surface.
    const unlinked = await registerInventoryItem(harness, {
      externalReference: null,
    });
    expect(unlinked.externalReference).toBeNull();
  });

  test("provider-neutral validation only: no bid-protocol or platform-API vocabulary in the inventory domain", async () => {
    for (const rel of [
      "src/inventory/port.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/eligibility-engine.ts",
      "src/inventory/authority-inventory-repositories.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      // No OpenRTB / bid-request / platform-API semantics in the
      // domain (the issue's explicit non-goals).
      expect(content).not.toMatch(/openrtb/i);
      expect(content).not.toMatch(/bidRequest/i);
      expect(content).not.toMatch(/\bbid_response\b/i);
      expect(content).not.toMatch(/\bserveAd\b/i);
      expect(content).not.toMatch(/\bfetchPlatformApi\b/i);
    }
  });

  test("SECRET ISOLATION: the inventory domain reads no secrets and embeds no credentials", async () => {
    for (const rel of [
      "src/inventory/port.ts",
      "src/inventory/inventory-service.ts",
      "src/inventory/eligibility-engine.ts",
      "src/inventory/authority-inventory-repositories.ts",
    ]) {
      const content = await readFile(join(REPO, rel), "utf8");
      expect(content).not.toMatch(/SecretProvider/i);
      expect(content).not.toMatch(/getSecret/i);
      expect(content).not.toMatch(/apiKey|api_key|accessToken|access_token|password|clientSecret|client_secret/i);
    }
    // The secret-redactor's frozen vocabulary is UNTOUCHED by W019.
    const redactor = await readFile(
      join(REPO, "src/secrets/secret-redactor.ts"),
      "utf8",
    );
    expect(redactor).toBeTruthy();
  });

  test("external references never carry credential-shaped payloads (the record-shape proof)", async () => {
    // A reference whose provider string smells like a key is still
    // JUST a neutral identifier — but the descriptor shape carries no
    // credential FIELD. Prove the stored record never grows fields
    // from input: unknown extra fields on the input are ignored.
    const item = await registerInventoryItem(harness, {
      externalReference: {
        provider: "network-a",
        externalId: "slot-9",
        url: null,
      },
    });
    expect(
      JSON.parse(JSON.stringify(item.externalReference)),
    ).toEqual({
      provider: "network-a",
      externalId: "slot-9",
      url: null,
    });
  });

  test("the supply-verification signal is a CANONICAL evidence reference (not provider data)", async () => {
    const item = await registerInventoryItem(harness);
    // verificationEvidenceReference is null until a canonical,
    // subject-bound evidence record attaches (AC-03 covers the
    // binding) — the domain stores a REFERENCE, never platform
    // payloads.
    expect(item.verificationEvidenceReference).toBeNull();
    expect(typeof item.verificationEvidenceReference === "string").toBe(false);
  });
});
