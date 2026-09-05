import { describe, it, expect } from "vitest";
import { reconcile, acknowledge, type AlertState, type AlertRecord } from "../src/action/state.js";
import { GitHubClient, issueBody, MARKER } from "../src/action/github.js";
import type { Alert } from "../src/watcher/join.js";
import type { Manifest } from "../src/manifest/schema.js";

const alert = (id: string, entryId: string, sev: "breaking" | "advisory" = "breaking"): Alert => ({
  id, provider: "stripe", code: "FIELD_REMOVED", severity: sev, operation: "GET /v1/subscriptions/{}", affected_path: "current_period_end",
  entry_ids: [entryId], locs: [{ file: "old.ts", line: 1 }], source: "observed",
  evidence: { from_version: "a", to_version: "b", change: { code: "FIELD_REMOVED", breaking: true, scope: "schema", schema: "subscription", side: "response", path: "current_period_end", detail: "current_period_end removed" } },
});
const manifestWith = (entryIds: string[], fields: string[] = ["current_period_end"]): Manifest => ({
  schema: 1, repo_id: "0123456789abcdef", scanner_version: "0", scanned_at: "2026-01-01T00:00:00.000Z", partial: false,
  providers: { stripe: { pinned_version: null, sdk: null, entries: entryIds.map((id) => ({ id, kind: "call" as const, operation: "GET /v1/subscriptions/{}", fields: fields.map((path) => ({ path, dir: "read" as const })), tier: 1 as const, fieldsComplete: true, locs: [{ file: "new.ts", line: 42 }] })) } },
  coverage: { t1: entryIds.length, t2: 0, t3: 0 },
});

describe("alert state", () => {
  it("opens new alerts, refreshes locations from the current manifest, and resolves when the code stops depending", () => {
    const e = "e000000000000001";
    let s: AlertState = { records: {} };
    let r = reconcile(s, [alert("a000000000000001", e)], manifestWith([e]), "t1");
    expect(r.opened).toHaveLength(1);
    expect(r.open[0].alert.locs).toEqual([{ file: "new.ts", line: 42 }]); // followed the code
    r = reconcile(r.state, [], manifestWith([e]), "t2");
    expect(r.opened).toHaveLength(0);
    expect(r.open).toHaveLength(1);
    // The entry id changes when an unrelated field is added; the alert must survive that.
    r = reconcile(r.state, [], manifestWith(["e000000000000002"], ["current_period_end", "status"]), "t2b");
    expect(r.open).toHaveLength(1);
    expect(r.open[0].alert.entry_ids).toEqual(["e000000000000002"]);
    // The field is no longer read: resolved.
    r = reconcile(r.state, [], manifestWith(["e000000000000003"], ["status"]), "t3");
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0].resolved_reason).toBe("code_no_longer_depends");
    expect(r.open).toHaveLength(0);
    // The dependency comes back with the same evidence: reopened, not duplicated.
    r = reconcile(r.state, [alert("a000000000000001", e)], manifestWith([e]), "t4");
    expect(r.opened).toHaveLength(1);
    expect(r.open[0].reopened_at).toBe("t4");
    expect(Object.keys(r.state.records)).toHaveLength(1);
  });

  it("an alert acknowledged by closing its issue stays closed even if the dependency remains", () => {
    const e = "e000000000000001";
    let r = reconcile({ records: {} }, [alert("a000000000000001", e)], manifestWith([e]), "t1");
    const acked = acknowledge(r.state, ["a000000000000001"], "t2");
    expect(acked.records["a000000000000001"].resolved_reason).toBe("issue_closed");
    r = reconcile(acked, [alert("a000000000000001", e)], manifestWith([e]), "t3");
    expect(r.opened).toHaveLength(0);
    expect(r.open).toHaveLength(0);
  });
});

describe("github client", () => {
  function fake() {
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    let issues: any[] = [];
    let nextNumber = 7;
    const f = (async (url: string, init: any) => {
      const path = url.replace("https://api.github.com", "");
      const body = init.body ? JSON.parse(init.body) : undefined;
      calls.push({ method: init.method, path, body });
      const json = (status: number, data: any) => new Response(JSON.stringify(data), { status });
      if (path.startsWith("/repos/o/r/issues?")) return json(200, issues);
      if (/^\/repos\/o\/r\/issues\/\d+$/.test(path) && init.method === "GET") return json(200, { number: 5, state: "closed" });
      if (path === "/repos/o/r/issues" && init.method === "POST") { const i = { number: nextNumber++, ...body }; issues.push(i); return json(201, i); }
      if (path === "/repos/o/r/labels") return json(422, { message: "already exists" });
      if (path === "/repos/o/r/check-runs") return json(201, { id: 99 });
      return json(200, {});
    }) as unknown as typeof fetch;
    return { f, calls, seed: (arr: any[]) => { issues = arr; } };
  }

  it("creates issues for open alerts, updates changed bodies, closes resolved ones", async () => {
    const { f, calls, seed } = fake();
    const gh = new GitHubClient({ token: "t", repo: "o/r", sha: "abc" }, f);
    const rec1: AlertRecord = { alert: alert("a000000000000001", "e1"), status: "open", first_seen: "t1" };
    const rec2: AlertRecord = { alert: alert("a000000000000002", "e2"), status: "open", first_seen: "t1" };
    const rec3: AlertRecord = { alert: alert("a000000000000003", "e3"), status: "resolved", first_seen: "t1" };
    seed([
      { number: 3, body: "stale body " + MARKER("a000000000000002") },
      { number: 4, body: issueBody(rec3) },
    ]);
    const rec4: AlertRecord = { alert: alert("a000000000000004", "e4"), status: "open", first_seen: "t1", issue_number: 5 }; // human closed #5
    const s = await gh.syncIssues([rec1, rec2, rec4], [rec3]);
    expect(s).toEqual({ created: 1, updated: 1, closed: 1, acknowledged: ["a000000000000004"] });
    expect(rec1.issue_number).toBe(7);
    expect(rec2.issue_number).toBe(3);
    const closes = calls.filter((c) => c.method === "PATCH" && c.path === "/repos/o/r/issues/4");
    expect(closes[0].body.state).toBe("closed");
  });

  it("chunks annotations by 50 and sets action_required when anything is breaking", async () => {
    const { f, calls } = fake();
    const gh = new GitHubClient({ token: "t", repo: "o/r", sha: "abc" }, f);
    const rec = { alert: alert("a000000000000001", "e1"), status: "open" as const, first_seen: "t1" };
    rec.alert.locs = Array.from({ length: 120 }, (_, i) => ({ file: "f.ts", line: i + 1 }));
    await gh.createCheckRun([rec], "summary");
    const post = calls.find((c) => c.path === "/repos/o/r/check-runs")!;
    expect(post.body.conclusion).toBe("action_required");
    expect(post.body.output.annotations).toHaveLength(50);
    expect(calls.filter((c) => c.path === "/repos/o/r/check-runs/99")).toHaveLength(2);
  });

  it("issue body carries the marker and every location", () => {
    const rec = { alert: alert("a000000000000001", "e1", "advisory"), status: "open" as const, first_seen: "t1" };
    rec.alert.severity_note = "code is pinned";
    const b = issueBody(rec);
    expect(b).toContain(MARKER("a000000000000001"));
    expect(b).toContain("old.ts:1");
    expect(b).toContain("Advisory");
    expect(b).toContain("code is pinned");
  });
});
