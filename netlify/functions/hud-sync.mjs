
import { getStore } from "@netlify/blobs";

const STORE_NAME = "closety-bridge";
const PREFIX = "session:";

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function reply(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function validToken(token) {
  return (
    typeof token === "string" &&
    token.length >= 8 &&
    token.length <= 200 &&
    /^[a-zA-Z0-9_-]+$/.test(token)
  );
}

function clean(value, max = 500) {
  return typeof value === "string"
    ? value.trim().slice(0, max)
    : "";
}

function cleanPaths(paths) {
  if (!Array.isArray(paths)) return [];

  return paths
    .filter((path) => typeof path === "string")
    .map((path) => path.trim())
    .filter(Boolean)
    .slice(0, 5000);
}

async function readSession(store, token) {
  return await store.get(`${PREFIX}${token}`, {
    type: "json",
  });
}

async function saveSession(store, token, session) {
  session.updatedAt = new Date().toISOString();
  await store.setJSON(`${PREFIX}${token}`, session);
}

function createSession(token, avatarUUID, avatarName) {
  const now = new Date().toISOString();

  return {
    token,
    avatarUUID,
    avatarName,
    paired: false,
    scanning: false,
    inventoryPaths: [],
    wornState: [],
    commands: [],
    commandResults: [],
    scanStartedAt: null,
    scanFinishedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (!["GET", "POST"].includes(request.method)) {
    return reply(405, {
      ok: false,
      error: `Method ${request.method} not allowed.`,
    });
  }

  try {
    const store = getStore(STORE_NAME);
    const url = new URL(request.url);

    let data = {};

    if (request.method === "GET") {
      data = {
        action: clean(url.searchParams.get("action"), 80),
        token: clean(url.searchParams.get("token"), 200),
      };
    } else {
      try {
        data = await request.json();
      } catch {
        return reply(400, {
          ok: false,
          error: "Request body must contain valid JSON.",
        });
      }
    }

    const action = clean(data.action, 80);
    const token = clean(data.token, 200);

    if (!validToken(token)) {
      return reply(400, {
        ok: false,
        error: "A valid token is required.",
      });
    }

    // Pairing creates or updates the session.
    if (request.method === "POST" && action === "pair") {
      const avatarUUID = clean(data.avatarUUID, 100);
      const avatarName = clean(data.avatarName, 100);

      if (!avatarUUID) {
        return reply(400, {
          ok: false,
          error: "avatarUUID is required.",
        });
      }

      const existing = await readSession(store, token);
      const session =
        existing || createSession(token, avatarUUID, avatarName);

      session.token = token;
      session.avatarUUID = avatarUUID;
      session.avatarName = avatarName;
      session.paired = true;

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        paired: true,
        message: "HUD paired successfully.",
      });
    }

    const session = await readSession(store, token);

    if (!session || !session.paired) {
      return reply(404, {
        ok: false,
        error: "Session not found. Pair the HUD first.",
      });
    }

    // Support both the website's "state" and "status" names.
    if (
      request.method === "GET" &&
      (action === "state" || action === "status")
    ) {
      return reply(200, {
        ok: true,
        connected: true,
        paired: true,
        avatarUUID: session.avatarUUID || "",
        avatarName: session.avatarName || "",
        scanning: Boolean(session.scanning),
        scanStatus: session.scanning
          ? "scanning"
          : session.scanFinishedAt
            ? "complete"
            : "waiting",
        folders: session.inventoryPaths || [],
        inventoryCount: (session.inventoryPaths || []).length,
        wornState: session.wornState || [],
        queuedCommands: (session.commands || []).length,
        commandResults: (session.commandResults || []).slice(-20),
        updatedAt: session.updatedAt || null,
        lastScan: session.scanFinishedAt || null,
      });
    }

    // HUD polls for a command.
    if (
      request.method === "GET" &&
      action === "next_command"
    ) {
      const command = (session.commands || []).shift() || null;

      if (command) {
        await saveSession(store, token, session);
      }

      return reply(200, { ok: true, command });
    }

    if (request.method !== "POST") {
      return reply(405, {
        ok: false,
        error: "This action requires POST.",
      });
    }

    if (action === "scan_start") {
      session.scanning = true;
      session.inventoryPaths = [];
      session.scanStartedAt = new Date().toISOString();
      session.scanFinishedAt = null;

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        message: "Inventory scan started.",
      });
    }

    if (action === "sync_chunk") {
      if (!session.scanning) {
        return reply(409, {
          ok: false,
          error: "No inventory scan is in progress.",
          scanning: false,
          scanStartedAt: session.scanStartedAt || null,
          scanFinishedAt: session.scanFinishedAt || null,
        });
      }

      const paths = cleanPaths(data.paths);
      const known = new Set(session.inventoryPaths || []);

      for (const path of paths) {
        if (!known.has(path)) {
          session.inventoryPaths.push(path);
          known.add(path);
        }
      }

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        received: paths.length,
        total: session.inventoryPaths.length,
      });
    }

    if (action === "scan_finish") {
      session.scanning = false;
      session.scanFinishedAt = new Date().toISOString();

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        total: session.inventoryPaths.length,
      });
    }

    if (action === "worn_state") {
      // The LSL HUD sends "wornOutfits".
      const items = Array.isArray(data.wornOutfits)
        ? data.wornOutfits
        : Array.isArray(data.items)
          ? data.items
          : [];

      session.wornState = items
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 1000);

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        count: session.wornState.length,
      });
    }

    if (action === "enqueue_command") {
      // The website sends command as an object.
      const input =
        data.command && typeof data.command === "object"
          ? data.command
          : {};

      const type = clean(
        input.action || input.command || data.type,
        80
      );

      if (!["wear", "remove", "strip_all"].includes(type)) {
        return reply(400, {
          ok: false,
          error: "Unsupported command.",
        });
      }

      const path = clean(input.path || data.path, 1000);
      const outfitName = clean(input.outfitName, 200);

      if ((type === "wear" || type === "remove") && !path) {
        return reply(400, {
          ok: false,
          error: "A path is required for this command.",
        });
      }

      const command = {
        id: crypto.randomUUID(),
        action: type,
        path,
        outfitName,
        createdAt: new Date().toISOString(),
      };

      session.commands.push(command);
      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        commandId: command.id,
      });
    }

    if (action === "command_result") {
      const result = {
        id: clean(data.id || data.commandId, 100),
        success: Boolean(data.success),
        message: clean(data.message, 1000),
        completedAt: new Date().toISOString(),
      };

      session.commandResults = [
        ...(session.commandResults || []),
        result,
      ].slice(-100);

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        message: "Command result saved.",
      });
    }

    return reply(400, {
      ok: false,
      error: `Unknown action: ${action || "(missing)"}`,
    });
  } catch (error) {
    console.error("Closety HUD sync error:", error);

    return reply(500, {
      ok: false,
      error: "Internal server error.",
    });
  }
}
