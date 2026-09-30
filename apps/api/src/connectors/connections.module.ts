import { Module } from "@nestjs/common";
import { ToolsModule } from "../tools/tools.module";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { buildConnector, CONNECTOR_FACTORY } from "./factory";
import { SyncService } from "./sync.service";

@Module({
  imports: [ToolsModule],
  controllers: [ConnectionsController],
  providers: [ConnectionsService, SyncService, { provide: CONNECTOR_FACTORY, useValue: buildConnector }],
  exports: [SyncService],
})
export class ConnectionsModule {}
