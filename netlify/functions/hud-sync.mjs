
import { getStore } from "@netlify/blobs";

const SESSION_LIFETIME = 7 * 24 * 60 * 60 * 1000;

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function reply(statusCode, data) {
  return new Response(
    statusCode === 204 ? null : JSON.stringify(data),
    { status: statusCode, headers }
  );
}

function validUUID(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

async function getSession(store, token) {
  if (!validUUID(token)) return null;

  const session = await store.get(`session:${token}`, {
    type: "json",
  });

  if (
    !session ||
    !session.expiresAt ||
    session.expiresAt < Date.now()
  ) {
    return null;
  }

  return session;
}

async function getFolders(store, token) {
  const folders = await store.get(`folders:${token}`, {
    type: "json",
  });

  return Array.isArray(folders) ? folders : [];
}

async function saveSession(store, session) {
  await store.setJSON(`session:${session.token}`, session);

  await store.setJSON(
    `avatar:${session.avatarUUID.toLowerCase()}`,
    {
      token: session.token,
      avatarUUID: session.avatarUUID,
      avatarName: session.avatarName,
      updatedAt: Date.now(),
    }
  );
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return reply(204, {});
  }

  try {
    const store = getStore("closety-wardrobes");
    const url = new URL(request.url);

    // Website reads session and folders from separate stored records.
    if (request.method === "GET") {
      const action = url.searchParams.get("action");
      const token = url.searchParams.get("token");

      if (action !== "state") {
        return reply(400, { error: "Unknown action." });
      }

      const session = await getSession(store, token);

      if (!session) {
        return reply(401, {
          connected: false,
          error: "Invalid or expired connection. Connect again using the HUD.",
        });
      }

      const folders = await getFolders(store, token);

      console.log("Closety state read:", {
        avatarUUID: session.avatarUUID,
        scanStatus: session.scanStatus,
        folderCount: folders.length,
      });

      return reply(200, {
        connected: true,
        avatarUUID: session.avatarUUID,
        avatarName: session.avatarName,
        scanStatus: session.scanStatus || "waiting",
        folders,
        lastSeen: session.lastSeen,
        updatedAt: session.updatedAt,
      });
    }

    if (request.method !== "POST") {
      return reply(405, { error: "Method not allowed." });
    }

    let body;

    try {
      body = await request.json();
    } catch {
      return reply(400, { error: "Invalid JSON request body." });
    }

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return reply(400, {
        error: "Request body must be a JSON object.",
      });
    }

    const action = body.action;

    // Create or renew the paired session.
    if (action === "pair") {
      if (!validUUID(body.token) || !validUUID(body.avatarUUID)) {
        return reply(400, {
          error: "Invalid pairing token or avatar UUID.",
        });
      }

      const now = Date.now();

      const session = {
        token: body.token,
        avatarUUID: body.avatarUUID,
        avatarName: String(
          body.avatarName || "Second Life avatar"
        ).slice(0, 100),
        scanStatus: "waiting",
        createdAt: now,
        updatedAt: now,
        lastSeen: now,
        expiresAt: now + SESSION_LIFETIME,
      };

      await store.setJSON(`folders:${body.token}`, []);
      await saveSession(store, session);

      console.log("Closety paired:", session.avatarUUID);

      return reply(200, { ok: true });
    }

    const session = await getSession(store, body.token);

    if (!session) {
      return reply(401, {
        error: "Connection expired. Please reconnect.",
      });
    }

    const now = Date.now();

    session.lastSeen = now;
    session.updatedAt = now;

    if (action === "scan_start") {
      // Clear only the folder record, not a session-embedded folder list.
      await store.setJSON(`folders:${body.token}`, []);

      session.scanStatus = "scanning";
      session.scanStartedAt = now;
      delete session.scanFinishedAt;

      await saveSession(store, session);

      console.log("Closety scan started:", session.avatarUUID);

      return reply(200, { ok: true, folderCount: 0 });
    }

    if (action === "sync_chunk") {
      if (!Array.isArray(body.paths)) {
        return reply(400, { error: "paths must be an array." });
      }

      const incoming = body.paths
        .filter((path) => typeof path === "string")
        .map((path) => path.trim())
        .filter((path) => path.length > 0 && path.length <= 500);

      // Save paths in their own record so session writes cannot erase them.
      const existing = await getFolders(store, body.token);
      const combined = [
        ...new Set([...existing, ...incoming]),
      ].slice(0, 10000);

      await store.setJSON(`folders:${body.token}`, combined);

      // Update session metadata separately.
      session.scanStatus = "scanning";
      await saveSession(store, session);

      console.log("Closety folders saved:", {
        avatarUUID: session.avatarUUID,
        received: incoming.length,
        totalSaved: combined.length,
        paths: incoming,
      });

      return reply(200, {
        ok: true,
        received: incoming.length,
        total: combined.length,
      });
    }

    if (action === "scan_finish") {
      // Never clear or rewrite the separate folder record here.
      const folders = await getFolders(store, body.token);

      session.scanStatus = "complete";
      session.scanFinishedAt = now;

      await saveSession(store, session);

      console.log("Closety scan finished:", {
        avatarUUID: session.avatarUUID,
        totalSaved: folders.length,
      });

      return reply(200, {
        ok: true,
        total: folders.length,
      });
    }

    return reply(400, { error: "Unknown action." });
  } catch (error) {
    console.error("Closety HUD sync error:", error);

    return reply(500, {
      error: "Server error. Check the Netlify function logs.",
    });
  }
}
