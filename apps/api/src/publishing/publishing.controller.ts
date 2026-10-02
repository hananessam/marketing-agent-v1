import { BadGatewayException, ConflictException, Controller, Get, UseGuards } from "@nestjs/common";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ConnectorAuthError, ConnectorError } from "../connectors/http";
import { PublishingService } from "./publishing.service";

@Controller("publishing")
@UseGuards(WorkspaceGuard)
export class PublishingController {
  constructor(private readonly publishing: PublishingService) {}

  /** Cheap: no calls to Meta. What is switched on, and what is missing. */
  @Get("status")
  status(@WorkspaceId() ws: string) {
    return this.publishing.status(ws);
  }

  /** Adds the ad account's currency and the Facebook Pages this login can post as (calls Meta). */
  @Get("meta")
  async meta(@WorkspaceId() ws: string) {
    try {
      return await this.publishing.metaDetails(ws);
    } catch (e) {
      if (e instanceof ConnectorAuthError) throw new ConflictException(e.message);
      if (e instanceof ConnectorError) throw new BadGatewayException(e.message);
      throw e;
    }
  }
}
