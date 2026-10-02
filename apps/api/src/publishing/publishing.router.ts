import { Injectable } from "@nestjs/common";
import { executionMode } from "./mode";
import { PublishingService } from "./publishing.service";
import { SandboxPublisher } from "./sandbox-publisher";
import type { ActionRow, MetaSettings, Outcome, Publisher } from "./types";

/**
 * Picks where publishing goes from EXECUTION_MODE: the built-in ads sandbox (demo, the default) or the real
 * ad platforms (live). Shadow mode uses the real service's checks, but nothing is ever posted.
 */
@Injectable()
export class PublishingRouter implements Publisher {
  constructor(private readonly real: PublishingService, private readonly sandbox: SandboxPublisher) {}

  get mode() {
    return executionMode();
  }

  status(workspaceId: string) {
    return this.mode === "demo" ? this.sandbox.status() : this.real.status(workspaceId);
  }

  metaDetails(workspaceId: string) {
    return this.mode === "demo" ? this.sandbox.details() : this.real.metaDetails(workspaceId);
  }

  preflight(workspaceId: string, campaignId: string, meta?: MetaSettings): void {
    return this.mode === "demo" ? this.sandbox.preflight(workspaceId, campaignId, meta) : this.real.preflight(workspaceId, campaignId, meta);
  }

  publish(action: ActionRow): Promise<Outcome> {
    return this.mode === "demo" ? this.sandbox.publish(action) : this.real.publish(action);
  }
}
