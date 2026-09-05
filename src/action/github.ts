/**
 * The only GitHub access the Action has is the workflow's own GITHUB_TOKEN,
 * scoped by the customer's workflow file (contents: read, checks: write,
 * issues: write). We use three endpoints. No SDK, no other permissions.
 */
import type { AlertRecord } from "./state.js";

export interface GitHubEnv {
  token: string;
  repo: string; // owner/name
  sha: string;
  apiUrl?: string;
}

type Fetch = typeof fetch;

export const MARKER = (id: string) => `<!-- arcdrip:alert:${id} -->`;
export const LABEL = "arcdrip";

export class GitHubClient {
  constructor(private readonly env: GitHubEnv, private readonly fetchImpl: Fetch = fetch) {}

  private async api<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.fetchImpl(`${this.env.apiUrl ?? "https://api.github.com"}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.env.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "arcdrip-action",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok && res.status !== 422) throw new Error(`GitHub ${method} ${path}: HTTP ${res.status} ${typeof data === "string" ? data : data?.message ?? ""}`);
    return { status: res.status, data };
  }

  /** One check run per workflow run: summary + annotations on affected lines (max 50 per request). */
  async createCheckRun(open: AlertRecord[], summary: string): Promise<void> {
    const annotations = open.flatMap((r) =>
      r.alert.locs.map((l) => ({
        path: l.file,
        start_line: l.line,
        end_line: l.line,
        annotation_level: r.alert.severity === "breaking" ? "failure" : "warning",
        title: `${r.alert.code}: ${r.alert.operation ?? `webhook ${r.alert.event}`}`,
        message: `${r.alert.evidence.change.detail} (${r.alert.evidence.from_version} -> ${r.alert.evidence.to_version})${r.alert.severity_note ? `\n${r.alert.severity_note}` : ""}`,
      })),
    );
    const conclusion = open.some((r) => r.alert.severity === "breaking") ? "action_required" : open.length ? "neutral" : "success";
    const base = {
      name: "arcdrip",
      head_sha: this.env.sha,
      status: "completed",
      conclusion,
      output: { title: open.length ? `${open.length} open alert(s)` : "No open alerts", summary },
    };
    // First request carries up to 50 annotations; the rest are appended via PATCH.
    const first = annotations.slice(0, 50);
    const created = await this.api("POST", `/repos/${this.env.repo}/check-runs`, { ...base, output: { ...base.output, annotations: first } });
    for (let i = 50; i < annotations.length; i += 50) {
      await this.api("PATCH", `/repos/${this.env.repo}/check-runs/${created.data.id}`, { output: { ...base.output, annotations: annotations.slice(i, i + 50) } });
    }
  }

  async ensureLabel(): Promise<void> {
    await this.api("POST", `/repos/${this.env.repo}/labels`, { name: LABEL, color: "b60205", description: "Third-party API change affecting this code" });
  }

  /** Open issues carrying our label, keyed by the alert id in their body marker. */
  async openIssues(): Promise<Map<string, { number: number; body: string }>> {
    const out = new Map<string, { number: number; body: string }>();
    for (let page = 1; page <= 10; page++) {
      const { data } = await this.api<any[]>("GET", `/repos/${this.env.repo}/issues?labels=${LABEL}&state=open&per_page=100&page=${page}`);
      if (!Array.isArray(data) || data.length === 0) break;
      for (const issue of data) {
        const m = /<!-- arcdrip:alert:([0-9a-f]{16}) -->/.exec(issue.body ?? "");
        if (m) out.set(m[1], { number: issue.number, body: issue.body });
      }
      if (data.length < 100) break;
    }
    return out;
  }

  /**
   * Bring issues in line with alert state: create for new opens, update bodies,
   * close resolved. An open record whose issue a human closed is reported back
   * as acknowledged and is NOT recreated.
   */
  async syncIssues(open: AlertRecord[], resolved: AlertRecord[]): Promise<{ created: number; updated: number; closed: number; acknowledged: string[] }> {
    await this.ensureLabel();
    const existing = await this.openIssues();
    let created = 0, updated = 0, closed = 0;
    const acknowledged: string[] = [];

    for (const rec of open) {
      const body = issueBody(rec);
      const found = existing.get(rec.alert.id);
      if (!found && rec.issue_number) {
        const { data } = await this.api("GET", `/repos/${this.env.repo}/issues/${rec.issue_number}`);
        if (data?.state === "closed") {
          acknowledged.push(rec.alert.id);
          continue;
        }
      }
      if (found) {
        rec.issue_number = found.number;
        if (found.body !== body) {
          await this.api("PATCH", `/repos/${this.env.repo}/issues/${found.number}`, { body });
          updated++;
        }
      } else {
        const { data } = await this.api("POST", `/repos/${this.env.repo}/issues`, { title: issueTitle(rec), body, labels: [LABEL] });
        rec.issue_number = data.number;
        created++;
      }
    }
    for (const rec of resolved) {
      const found = existing.get(rec.alert.id);
      if (!found) continue;
      await this.api("POST", `/repos/${this.env.repo}/issues/${found.number}/comments`, {
        body: "Resolved: the code no longer depends on the affected field or operation. Closing.",
      });
      await this.api("PATCH", `/repos/${this.env.repo}/issues/${found.number}`, { state: "closed", state_reason: "completed" });
      closed++;
    }
    return { created, updated, closed, acknowledged };
  }
}

export function issueTitle(rec: AlertRecord): string {
  const a = rec.alert;
  const where = a.operation ?? `webhook ${a.event}`;
  return `[arcdrip] ${a.code}: ${where}${a.affected_path ? ` → ${a.affected_path}` : ""}`;
}

export function issueBody(rec: AlertRecord): string {
  const a = rec.alert;
  const lines = [
    `**${a.severity === "breaking" ? "Breaking" : "Advisory"}** — Stripe changed something this code depends on.`,
    "",
    `| | |`,
    `|---|---|`,
    `| Change | \`${a.code}\` — ${a.evidence.change.detail}${a.evidence.change.schema ? ` (schema \`${a.evidence.change.schema}\`)` : ""} |`,
    `| Where in the API | ${a.operation ? `\`${a.operation}\`` : `webhook \`${a.event}\``}${a.affected_path ? ` — this code reads/writes \`${a.affected_path}\`` : ""} |`,
    `| Between versions | \`${a.evidence.from_version}\` → \`${a.evidence.to_version}\` |`,
    ...(a.severity_note ? [`| Applies when | ${a.severity_note} |`] : []),
    `| First seen | ${rec.first_seen} |`,
    "",
    "**Affected code**",
    ...a.locs.map((l) => `- \`${l.file}:${l.line}\``),
    "",
    "This issue is maintained by arcdrip. It closes itself when the code no longer depends on the affected field or operation. Close it manually to acknowledge.",
    "",
    MARKER(a.id),
  ];
  return lines.join("\n");
}
