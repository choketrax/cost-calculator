// Cloudflare Worker — AI Cost Auditor Gateway
// Handles authentication and proxies to FastAPI container.
// 
// Requires @cloudflare/containers package (npm install @cloudflare/containers)
//
// The Container class uses Durable Objects to manage the FastAPI container lifecycle.
// The outboundByHost handlers allow the Python container to access D1 and R2
// via plain HTTP calls to http://my.d1 and http://my.r2 virtual hostnames.

import { Container, getContainer } from "@cloudflare/containers";

export interface Env {
  AUDITOR_CONTAINER: DurableObjectNamespace;
  DB: D1Database;
  AUDIT_STORAGE: R2Bucket;
  API_KEY: string;
  APP_ENV: string;
}

/**
 * AuditorContainer — Cloudflare Container wrapping the FastAPI app.
 * 
 * The FastAPI app runs on port 8000 inside the container.
 * outboundByHost intercepts Python HTTP calls to virtual hostnames:
 *   http://my.d1/query  → D1 SQL execution
 *   http://my.r2/{key}  → R2 object storage
 */
export class AuditorContainer extends Container {
  defaultPort = 8000;
  sleepAfter = "30m"; // Scale-to-zero after 30 minutes of inactivity

  // Pass environment variables from the Worker to the Python Container
  envVars() {
    return {
      API_KEY: this.env.API_KEY || "missing-key-please-set",
      APP_ENV: this.env.APP_ENV || "production",
      STORAGE_BACKEND: "cloudflare",
    };
  }

  // Outbound handler: intercepts HTTP calls from Python container to Cloudflare services
  static outboundByHost: Record<
    string,
    (request: Request, env: Env) => Promise<Response>
  > = {
    // D1 handler: Python calls POST http://my.d1/query with {query, params}
    "my.d1": async (request: Request, env: Env): Promise<Response> => {
      try {
        const body = await request.json() as { query: string; params?: unknown[] };
        const { query, params = [] } = body;
        const stmt = env.DB.prepare(query);
        const result = await stmt.bind(...params).all();
        return Response.json({ success: true, results: result.results, meta: result.meta });
      } catch (err) {
        const message = err instanceof Error ? err.message : "D1 query failed";
        return Response.json({ success: false, error: message }, { status: 500 });
      }
    },

    // R2 handler: Python calls GET/PUT/DELETE http://my.r2/{key}
    "my.r2": async (request: Request, env: Env): Promise<Response> => {
      try {
        const url = new URL(request.url);
        const key = url.pathname.slice(1); // Remove leading /

        if (request.method === "PUT") {
          const contentType = request.headers.get("Content-Type") ?? "application/octet-stream";
          await env.AUDIT_STORAGE.put(key, request.body, {
            httpMetadata: { contentType },
          });
          return new Response(JSON.stringify({ success: true, key }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (request.method === "DELETE") {
          await env.AUDIT_STORAGE.delete(key);
          return new Response(JSON.stringify({ success: true }), {
            headers: { "Content-Type": "application/json" },
          });
        }

        if (request.method === "GET") {
          const obj = await env.AUDIT_STORAGE.get(key);
          if (!obj) {
            return new Response(JSON.stringify({ error: "Not Found" }), {
              status: 404,
              headers: { "Content-Type": "application/json" },
            });
          }
          const contentType = obj.httpMetadata?.contentType ?? "application/octet-stream";
          return new Response(obj.body, {
            headers: { "Content-Type": contentType },
          });
        }

        // LIST: GET http://my.r2/?prefix=audits/
        if (request.method === "GET" && url.pathname === "/") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const listed = await env.AUDIT_STORAGE.list({ prefix });
          return Response.json({
            keys: listed.objects.map((o) => ({ key: o.key, size: o.size })),
            truncated: listed.truncated,
          });
        }

        return new Response("Method Not Allowed", { status: 405 });
      } catch (err) {
        const message = err instanceof Error ? err.message : "R2 operation failed";
        return Response.json({ success: false, error: message }, { status: 500 });
      }
    },
  };
}

// Worker entry point — authenticates and proxies to container
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check and version endpoints bypass auth
    if (
      url.pathname === "/api/v1/health" ||
      url.pathname === "/api/v1/version"
    ) {
      const container = getContainer(env.AUDITOR_CONTAINER, "default");
      return container.fetch(request);
    }

    // All other endpoints require API key
    const apiKey = request.headers.get("X-API-Key");
    if (!apiKey || apiKey !== env.API_KEY) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" },
        }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": "ApiKey",
          },
        }
      );
    }

    // Basic request size check (50MB limit matches FastAPI config)
    const contentLength = request.headers.get("Content-Length");
    if (contentLength && parseInt(contentLength) > 50 * 1024 * 1024) {
      return new Response(
        JSON.stringify({
          status: "error",
          error: { code: "PAYLOAD_TOO_LARGE", message: "Request exceeds 50MB limit" },
        }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }

    // Log the request path (no body content)
    console.log(`[${request.method}] ${url.pathname}`);

    // Proxy authenticated request to container
    const container = getContainer(env.AUDITOR_CONTAINER, "default");
    return container.fetch(request);
  },
};
