import { Module } from "@nestjs/common";
import { DB } from "../db/database.module";
import type { Db } from "../db";
import { JOB_QUEUE, type JobQueue } from "../queue/queue.port";
import { OAuthController } from "../oauth/oauth.controller";
import { OAuthService } from "../oauth/oauth.service";
import { createProviders, OAUTH_PROVIDERS } from "../oauth/providers";
import { QueueModule } from "../queue/queue.module";
import { ToolsModule } from "../tools/tools.module";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { buildConnector, CONNECTOR_FACTORY } from "./factory";
import { SyncScheduleService } from "./sync-schedule.service";
import { SyncService } from "./sync.service";

@Module({
  imports: [ToolsModule, QueueModule],
  // OAuthController first: its literal "connections/oauth/..." routes must win over "connections/:id".
  controllers: [OAuthController, ConnectionsController],
  providers: [
    ConnectionsService, SyncService, OAuthService,
    // A factory, because the constructor takes an optional `env` that Nest must not try to inject (tests pass their own).
    { provide: SyncScheduleService, useFactory: (db: Db, queue: JobQueue) => new SyncScheduleService(db, queue), inject: [DB, JOB_QUEUE] },
    { provide: CONNECTOR_FACTORY, useValue: buildConnector },
    { provide: OAUTH_PROVIDERS, useFactory: () => createProviders() },
  ],
  exports: [SyncService, SyncScheduleService],
})
export class ConnectionsModule {}
