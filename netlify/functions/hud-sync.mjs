
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
    .filter((p) => typeof p === "string")
    .map((p) => p.trim())
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers,
    });
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
      data.action = clean(url.searchParams.get("action"), 80);
      data.token = clean(url.searchParams.get("token"), 200);
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

    // Pair the HUD with a session.
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
        existing ||
        createSession(token, avatarUUID, avatarName);

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

    // HUD polls for the next command.
    if (
      request.method === "GET" &&
      action === "next_command"
    ) {
      const command = session.commands.shift() || null;

      if (command) {
        await saveSession(store, token, session);
      }

      return reply(200, {
        ok: true,
        command,
      });
    }

    // Website checks session status.
    if (
      request.method === "GET" &&
      action === "status"
    ) {
      return reply(200, {
        ok: true,
        paired: session.paired,
        avatarUUID: session.avatarUUID,
        avatarName: session.avatarName,
        scanning: session.scanning,
        inventoryCount: session.inventoryPaths.length,
        queuedCommands: session.commands.length,
        lastScan: session.scanFinishedAt,
        wornState: session.wornState,
        commandResults: session.commandResults.slice(-20),
      });
    }

    if (request.method !== "POST") {
      return reply(405, {
        ok: false,
        error: "This action requires POST.",
      });
    }

    // Start scanning the #RLV/WC inventory root.
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

    // Save scanned inventory paths.
    if (action === "sync_chunk") {
      if (!session.scanning) {
        return reply(409, {
          ok: false,
          error: "No inventory scan is in progress.",
        });
      }

      const paths = cleanPaths(data.paths);
      const known = new Set(session.inventoryPaths);

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

    // Finish scanning.
    if (action === "scan_finish") {
      session.scanning = false;
      session.scanFinishedAt = new Date().toISOString();

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        total: session.inventoryPaths.length,
      });
    }

    // Update worn inventory state.
    if (action === "worn_state") {
      const items = Array.isArray(data.items) ? data.items : [];

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

    // Queue a command for the HUD.
    if (action === "enqueue_command") {
      const type = clean(data.command || data.type, 80);

      if (!["wear", "remove", "strip_all"].includes(type)) {
        return reply(400, {
          ok: false,
          error: "Unsupported command.",
        });
      }

      const path = clean(data.path, 1000);

      if (
        (type === "wear" || type === "remove") &&
        !path
      ) {
        return reply(400, {
          ok: false,
          error: "A path is required for this command.",
        });
      }

      const command = {
        id: crypto.randomUUID(),
        command: type,
        path,
        createdAt: new Date().toISOString(),
      };

      session.commands.push(command);

      await saveSession(store, token, session);

      return reply(200, {
        ok: true,
        commandId: command.id,
      });
    }

    // Save command results from the HUD.
    if (action === "command_result") {
      const result = {
        id: clean(data.id || data.commandId, 100),
        success: Boolean(data.success),
        message: clean(data.message, 1000),
        completedAt: new Date().toISOString(),
      };

      session.commandResults.push(result);
      session.commandResults =
        session.commandResults.slice(-100);

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
