import { Body, Controller, Get, Put, UseGuards } from "@nestjs/common";
import { WorkspaceGuard, WorkspaceId } from "../common/workspace.guard";
import { ZodValidationPipe } from "../common/zod-validation.pipe";
import { CompanyBody, CompanyService } from "./company.service";

@Controller("company")
@UseGuards(WorkspaceGuard)
export class CompanyController {
  constructor(private readonly company: CompanyService) {}

  @Get()
  get(@WorkspaceId() ws: string) {
    return this.company.get(ws);
  }

  @Put()
  save(@WorkspaceId() ws: string, @Body(new ZodValidationPipe(CompanyBody)) body: CompanyBody) {
    return this.company.save(ws, body);
  }
}
