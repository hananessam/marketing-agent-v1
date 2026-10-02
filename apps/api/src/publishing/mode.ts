export type ExecutionMode = "demo" | "shadow" | "live";

/** Demo (the built-in ads sandbox) unless the server is explicitly set to "live" or "shadow". */
export function executionMode(): ExecutionMode {
  const m = process.env.EXECUTION_MODE?.trim().toLowerCase();
  return m === "live" || m === "shadow" ? m : "demo";
}
