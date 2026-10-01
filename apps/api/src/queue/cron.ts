import { BadRequestException } from "@nestjs/common";
import { CronExpressionParser } from "cron-parser";

/** Every scheduled run costs an LLM call or API quota, so refuse anything more frequent than this. */
export const MIN_INTERVAL_MS = 60 * 60 * 1000;

export function validateCron(cron: string, timezone: string) {
  try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new BadRequestException(`Unknown timezone "${timezone}"`); }
  let it: ReturnType<typeof CronExpressionParser.parse>;
  try { it = CronExpressionParser.parse(cron, { tz: timezone }); } catch { throw new BadRequestException(`Invalid cron expression "${cron}"`); }
  if (cron.trim().split(/\s+/).length !== 5) throw new BadRequestException("Use a standard 5-field cron expression");
  let prev = it.next().getTime();
  for (let i = 0; i < 6; i++) {
    const next = it.next().getTime();
    if (next - prev < MIN_INTERVAL_MS) throw new BadRequestException("Schedules may run at most once per hour");
    prev = next;
  }
}
