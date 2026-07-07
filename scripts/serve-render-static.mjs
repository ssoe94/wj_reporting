import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const root = resolve(process.env.WJ_STATIC_ROOT || join(repoRoot, "frontend", "dist"));
const port = Number(process.env.WJ_STATIC_PORT || 5184);
const host = process.env.WJ_STATIC_HOST || "127.0.0.1";
const apiProxyOrigin = process.env.WJ_STATIC_API_PROXY?.replace(/\/$/, "");

const nextAppRoutes = new Set([
  "/next/login",
  "/next/login/",
  "/next/production",
  "/next/production/",
  "/next/production/plans",
  "/next/production/plans/",
  "/next/mes/monitoring",
  "/next/mes/monitoring/",
]);

function json(res, body) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function base64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function token(kind) {
  return `${base64Url({ alg: "HS256", typ: "JWT" })}.${base64Url({
    token_type: kind,
    exp: Math.floor(Date.now() / 1000) + 86400,
  })}.qa`;
}

function contentType(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".jpg") || file.endsWith(".jpeg")) return "image/jpeg";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".ico")) return "image/x-icon";
  return "application/octet-stream";
}

function safeFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.replace(/^\/+/, ""));
  const file = resolve(root, decoded);
  return file === root || file.startsWith(`${root}\\`) || file.startsWith(`${root}/`) ? file : null;
}

function mockCurrentUser() {
  return {
    id: 1,
    username: "qa-user",
    email: "qa@example.com",
    is_staff: false,
    groups: ["qa"],
    department: "QA",
    permissions: {
      can_view_injection: true,
      can_view_assembly: true,
      can_view_quality: true,
      can_view_sales: true,
      can_view_development: true,
      can_edit_injection: false,
      can_edit_assembly: false,
      can_edit_quality: false,
      can_edit_sales: false,
      can_edit_development: false,
      can_edit_machining: false,
      can_edit_eco: false,
      can_edit_inventory: false,
      is_admin: false,
    },
  };
}

function emptyProductionPlanSummary(date) {
  return {
    plan_date: date,
    latest_updated_at: null,
    injection: { records: [], machine_summary: [], model_summary: [] },
    machining: { records: [], machine_summary: [], model_summary: [] },
  };
}

function emptyMesMatrix() {
  return {
    timestamp: new Date().toISOString(),
    time_slots: [],
    rollup_time_slots: [],
    hourly_rollup_time_slots: [],
    rollup_bucket_minutes: 30,
    interval_type: "30min",
    machine_numbers: [],
    actual_production_matrix: {},
    cumulative_production_matrix: {},
    temperature_matrix: {},
    power_usage_matrix: {},
    setup_data: {},
    mes_source: true,
  };
}

function apiResponse(url) {
  const date = url.searchParams.get("date") || url.searchParams.get("business_date") || "2026-07-02";

  if (url.pathname === "/api/token/" || url.pathname === "/api/token") {
    return { access: token("access"), refresh: token("refresh") };
  }
  if (url.pathname === "/api/token/refresh/" || url.pathname === "/api/token/refresh") {
    return { access: token("access") };
  }
  if (url.pathname === "/api/injection/user/me/" || url.pathname === "/api/injection/user/me") {
    return mockCurrentUser();
  }
  if (url.pathname.startsWith("/api/production/plan-dates")) {
    return { injection: [date], machining: [date] };
  }
  if (url.pathname.startsWith("/api/production/plan-summary")) {
    return emptyProductionPlanSummary(date);
  }
  if (url.pathname.startsWith("/api/production/plan-change-logs")) {
    return { date, latest_updated_at: null, logs: [] };
  }
  if (url.pathname.startsWith("/api/production/status")) {
    return { injection: [], machining: [] };
  }
  if (url.pathname.startsWith("/api/production/mes-report-stats")) {
    return {
      date,
      plan_type: url.searchParams.get("plan_type") || "injection",
      total_actual: 0,
      total_plan: 0,
      records: [],
      totals: {},
      summary: {},
    };
  }
  if (url.pathname.startsWith("/api/production/ai/briefing")) {
    return {
      answer: "QA static preview data is empty.",
      severity: "normal",
      source: "calculated",
    };
  }
  if (url.pathname.startsWith("/api/injection/monitoring-dates")) {
    return {
      dates: [date],
      latest_timestamp: null,
      earliest_timestamp: null,
    };
  }
  if (url.pathname.startsWith("/api/injection/production-matrix")) {
    return emptyMesMatrix();
  }
  if (url.pathname.startsWith("/api/injection/update-recent-snapshots")) {
    return { status: "idle", updated: 0 };
  }

  return {};
}

function shouldMockApi(url) {
  return (
    url.pathname === "/api/token/" ||
    url.pathname === "/api/token" ||
    url.pathname === "/api/token/refresh/" ||
    url.pathname === "/api/token/refresh" ||
    url.pathname === "/api/injection/user/me/" ||
    url.pathname === "/api/injection/user/me"
  );
}

async function proxyApi(url, req, res) {
  const target = `${apiProxyOrigin}${url.pathname}${url.search}`;
  const headers = { ...req.headers };
  delete headers.host;
  if (process.env.WJ_STATIC_API_PROXY_AUTH !== "passthrough") {
    delete headers.authorization;
  }

  const response = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req,
    duplex: "half",
  });

  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") || "application/octet-stream",
    "cache-control": response.headers.get("cache-control") || "no-store",
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  res.end(buffer);
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (url.pathname.startsWith("/api/")) {
    if (apiProxyOrigin && !shouldMockApi(url)) {
      proxyApi(url, req, res).catch((error) => {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : "API proxy failed" }));
      });
      return;
    }

    json(res, apiResponse(url));
    return;
  }

  if (url.pathname === "/injection/monitoring" || url.pathname === "/injection/monitoring/") {
    res.writeHead(302, { location: "/mes/monitoring" });
    res.end();
    return;
  }

  const file = safeFilePath(url.pathname);
  if (file && existsSync(file) && statSync(file).isFile()) {
    res.writeHead(200, { "content-type": contentType(file) });
    createReadStream(file).pipe(res);
    return;
  }

  if (nextAppRoutes.has(url.pathname)) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(join(root, "next", "index.html")));
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(readFileSync(join(root, "index.html")));
});

server.listen(port, host, () => {
  console.log(`serving ${root} at http://${host}:${port}`);
});
