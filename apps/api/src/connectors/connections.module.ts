import { Module } from "@nestjs/common";
import { OAuthController } from "../oauth/oauth.controller";
import { OAuthService } from "../oauth/oauth.service";
import { createProviders, OAUTH_PROVIDERS } from "../oauth/providers";
import { ToolsModule } from "../tools/tools.module";
import { ConnectionsController } from "./connections.controller";
import { ConnectionsService } from "./connections.service";
import { buildConnector, CONNECTOR_FACTORY } from "./factory";
import { SyncService } from "./sync.service";

@Module({
  imports: [ToolsModule],
  // OAuthController first: its literal "connections/oauth/..." routes must win over "connections/:id".
  controllers: [OAuthController, ConnectionsController],
  providers: [
    ConnectionsService, SyncService, OAuthService,
    { provide: CONNECTOR_FACTORY, useValue: buildConnector },
    { provide: OAUTH_PROVIDERS, useFactory: () => createProviders() },
  ],
  exports: [SyncService],
})
export class ConnectionsModule {}
