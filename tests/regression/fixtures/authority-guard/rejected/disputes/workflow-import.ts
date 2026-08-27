/**
 * NEGATIVE fixture — must be REJECTED: /disputes directly importing the
 * workflow authority.
 *
 * Watchpoint 1: /disputes may consume provider-neutral references, but
 * must not become a second workflow authority — lifecycle movement is
 * requested through the neutral delegation surface, never by importing
 * /workflows directly.
 *
 * Expected violation: single-authority-domain-import.
 */

import type { WorkflowServiceAPI } from "../workflows/workflow-service.ts";

export async function enforceDisputeHold(api: WorkflowServiceAPI, subjectId: string): Promise<void> {
  void api;
  void subjectId;
}
