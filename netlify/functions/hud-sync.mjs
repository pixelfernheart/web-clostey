
import { getStore } from "@netlify/blobs";

const store = getStore("closety-wardrobes");
const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function reply(statusCode, data) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(data),
  };
}

function validUUID(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function getSession(token) {
  if (!validUUID(token)) return null;

  const session = await store.get(`session:${token}`, {
    type: "json",
  });

  if (!session || session.expiresAt < Date.now()) {
    return null;
  }

  return session;
}

async function saveSession(session) {
  await store.setJSON(`session:${session.token}`, session);
  await store.setJSON(`avatar:${session.avatarUUID.toLowerCase()}`, {
    token: session.token,
    avatarUUID: session.avatarUUID,
    avatarName: session.avatarName,
    updatedAt: Date.now(),
  });
}

export default async (request) => {
  if (request.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: "",
    };
  }

  try {
    const url = new URL(request.url);

    if (request.method === "GET") {
      const action = url.searchParams.get("action");
      const token = url.searchParams.get("token");

      if (action !== "state") {
        return reply(400, { error: "Unknown action." });
      }

      const session = await getSession(token);

      if (!session) {
        return reply(401, {
          connected: false,
          error: "Invalid or expired connection. Connect again using the HUD.",
        });
      }

      return reply(200, {
        connected: true,
        avatarUUID: session.avatarUUID,
        avatarName: session.avatarName,
        scanStatus: session.scanStatus,
        folders: session.folders,
        lastSeen: session.lastSeen,
        updatedAt: session.updatedAt,
      });
    }

    if (request.method !== "POST") {
      return reply(405, { error: "Method not allowed." });
    }

    const body = JSON.parse(request.body || "{}");
    const action = body.action;

    if (action === "pair") {
      if (!validUUID(body.token) || !validUUID(body.avatarUUID)) {
        return reply(400, { error: "Invalid pairing token or avatar UUID." });
      }

      const now = Date.now();
      const session = {
        token: body.token,
        avatarUUID: body.avatarUUID,
        avatarName: String(body.avatarName || "Second Life avatar").slice(0, 100),
        scanStatus: "waiting",
        folders: [],
        createdAt: now,
        updatedAt: now,
        lastSeen: now,
        expiresAt: now + SESSION_LIFETIME,
      };

      await saveSession(session);

      return reply(200, {
        ok: true,
        message: "HUD paired with Closety.",
      });
    }

    const session = await getSession(body.token);

    if (!session) {
      return reply(401, { error: "Connection expired. Please reconnect." });
    }

    const now = Date.now();
    session.lastSeen = now;
    session.updatedAt = now;

    if (action === "scan_start") {
      session.folders = [];
      session.scanStatus = "scanning";
      session.scanStartedAt = now;
      await saveSession(session);

      return reply(200, { ok: true });
    }

    if (action === "sync_chunk") {
      if (session.scanStatus !== "scanning") {
        return reply(409, { error: "Start a scan before sending folders." });
      }

      if (!Array.isArray(body.paths)) {
        return reply(400, { error: "paths must be an array." });
      }

      const incoming = body.paths
        .filter((path) => typeof path === "string")
        .map((path) => path.trim())
        .filter((path) => path.length > 0 && path.length <= 500);

      session.folders = [...new Set([...session.folders, ...incoming])].slice(0, 10000);
      await saveSession(session);

      return reply(200, {
        ok: true,
        received: incoming.length,
        total: session.folders.length,
      });
    }

    if (action === "scan_finish") {
      session.scanStatus = "complete";
      session.scanFinishedAt = now;
      await saveSession(session);

      return reply(200, {
        ok: true,
        total: session.folders.length,
      });
    }

    return reply(400, { error: "Unknown action." });
  } catch (error) {
    console.error("Closety HUD sync error:", error);
    return reply(500, { error: "Server error. Check the Netlify function logs." });
  }
};
