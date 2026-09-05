import type { Alert } from "./join.js";
import type { Change } from "./diff.js";

export function renderAlerts(alerts: Alert[]): string {
  if (alerts.length === 0) return "No alerts: nothing this code depends on changed.\n";
  const lines: string[] = [];
  const breaking = alerts.filter((a) => a.severity === "breaking");
  const advisory = alerts.filter((a) => a.severity === "advisory");
  lines.push(`${alerts.length} alert(s): ${breaking.length} breaking, ${advisory.length} advisory\n`);
  for (const a of alerts) {
    const where = a.operation ? `${a.operation}` : `webhook ${a.event}`;
    lines.push(`[${a.severity.toUpperCase()}] ${a.code}  ${where}${a.affected_path ? `  reads/writes ${a.affected_path}` : ""}`);
    lines.push(`  what changed: ${a.evidence.change.detail}${a.evidence.change.schema ? ` (schema ${a.evidence.change.schema})` : ""}`);
    lines.push(`  between:      ${a.evidence.from_version} -> ${a.evidence.to_version}`);
    if (a.severity_note) lines.push(`  note:         ${a.severity_note}`);
    for (const l of a.locs) lines.push(`  at:           ${l.file}:${l.line}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function summarizeChanges(changes: Change[]): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.code, (counts.get(c.code) ?? 0) + 1);
  const lines = [...counts.entries()].sort().map(([k, v]) => `  ${k.padEnd(28)} ${v}`);
  return `${changes.length} change(s), ${changes.filter((c) => c.breaking).length} breaking\n${lines.join("\n")}\n`;
}
