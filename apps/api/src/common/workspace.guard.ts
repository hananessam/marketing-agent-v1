import {
  CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable,
  UnauthorizedException, createParamDecorator,
} from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DB } from "../db/database.module";
import { schema, type Db } from "../db";

/**
 * Tenant isolation: every request must name a workspace that exists.
 * Placeholder for real auth (OAuth/session) — the workspace id must later come from the
 * authenticated principal, never from a client-controlled header.
 */
@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const id = req.headers["x-workspace-id"];
    if (typeof id !== "string" || !id) throw new UnauthorizedException("Missing x-workspace-id");
    const ws = this.db.select({ id: schema.workspaces.id }).from(schema.workspaces).where(eq(schema.workspaces.id, id)).get();
    if (!ws) throw new ForbiddenException("Unknown workspace");
    req.workspaceId = ws.id;
    return true;
  }
}

export const WorkspaceId = createParamDecorator((_: unknown, ctx: ExecutionContext): string =>
  ctx.switchToHttp().getRequest().workspaceId);
