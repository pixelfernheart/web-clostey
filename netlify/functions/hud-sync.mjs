
import { getStore } from "@netlify/blobs";

const STORE_NAME = "closety-bridge";
const SESSION_PREFIX = "session:";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json",
};

function response(statusCode, data) {
  return {
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(data),
  };
}

function getToken(data = {}) {
  return String(data.token || "").trim();
}

function validToken(token) {
  return (
    token.length >= 8 &&
    token.length <= 200 &&
    /^[a-zA-Z0-9_-]+$/.test(token)
  );
}

function sessionKey(token) {
  return `${SESSION_PREFIX}${token}`;
}

function cleanString(value, maxLength = 500) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
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
  return await store.get(sessionKey(token), { type: "json" });
}

async function saveSession(store, token, session) {
  session.updatedAt = new Date().toISOString();

  await store.setJSON(sessionKey(token), session);
}

function newSession(token, avatarUUID = "", avatarName = "") {
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

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: "",
    };
  }

  const store = getStore(STORE_NAME);

  try {
    const method = event.httpMethod;
    const query = event.queryStringParameters || {};

    if (method === "GET") {
      const action = cleanString(query.action, 80);
      const token = cleanString(query.token, 200);

      if (!validToken(token)) {
        return response(400, {
          ok: false,
          error: "A valid token is required.",
        });
      }

      const session = await readSession(store, token);

      if (!session || !session.paired) {
        return response(404, {
          ok: false,
          error: "Session not found or not paired.",
        });
      }

      if (action === "next_command") {
        const command = session.commands.shift() || null;

        if (command) {
          await saveSession(store, token, session);
        }

        return response(200, {
          ok: true,
          command,
        });
      }

      if (action === "status") {
        return response(200, {
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

      return response(400, {
        ok: false,
        error: "Unknown GET action.",
      });
    }

    if (method !== "POST") {
      return response(405, {
        ok: false,
        error: "Method not allowed.",
      });
    }

    let data;

    try {
      data = JSON.parse(event.body || "{}");
    } catch {
      return response(400, {
        ok: false,
        error: "Invalid JSON body.",
      });
    }

    const action = cleanString(data.action, 80);
    const token = getToken(data);

    if (!validToken(token)) {
      return response(400, {
        ok: false,
        error: "A valid token is required.",
      });
    }

    // Pair the HUD with the website session.
    if (action === "pair") {
      const avatarUUID = cleanString(data.avatarUUID, 100);
      const avatarName = cleanString(data.avatarName, 100);

      if (!avatarUUID) {
        return response(400, {
          ok: false,
          error: "avatarUUID is required.",
        });
      }

      const existing = await readSession(store, token);
      const session =
        existing || newSession(token, avatarUUID, avatarName);

      session.token = token;
      session.avatarUUID = avatarUUID;
      session.avatarName = avatarName;
      session.paired = true;

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        paired: true,
        message: "HUD paired successfully.",
      });
    }

    // All remaining actions require an existing paired session.
    const session = await readSession(store, token);

    if (!session || !session.paired) {
      return response(404, {
        ok: false,
        error: "Session not found. Pair the HUD first.",
      });
    }

    // Begin an inventory scan.
    if (action === "scan_start") {
      session.scanning = true;
      session.inventoryPaths = [];
      session.scanStartedAt = new Date().toISOString();
      session.scanFinishedAt = null;

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        message: "Inventory scan started.",
      });
    }

    // Add inventory paths from a scan chunk.
    if (action === "sync_chunk") {
      if (!session.scanning) {
        return response(409, {
          ok: false,
          error: "No inventory scan is in progress.",
        });
      }

      const paths = cleanPaths(data.paths);
      const existingPaths = new Set(session.inventoryPaths);

      for (const path of paths) {
        if (!existingPaths.has(path)) {
          session.inventoryPaths.push(path);
          existingPaths.add(path);
        }
      }

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        received: paths.length,
        total: session.inventoryPaths.length,
      });
    }

    // Mark the inventory scan as complete.
    if (action === "scan_finish") {
      session.scanning = false;
      session.scanFinishedAt = new Date().toISOString();

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        total: session.inventoryPaths.length,
        message: "Inventory scan completed.",
      });
    }

    // Update the current worn-item state.
    if (action === "worn_state") {
      const items = Array.isArray(data.items) ? data.items : [];

      session.wornState = items
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 1000);

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        count: session.wornState.length,
      });
    }

    // Queue a command for the HUD to retrieve.
    if (action === "enqueue_command") {
      const commandType = cleanString(
        data.command || data.type,
        80
      );

      const allowedCommands = new Set([
        "wear",
        "remove",
        "strip_all",
      ]);

      if (!allowedCommands.has(commandType)) {
        return response(400, {
          ok: false,
          error: "Unsupported command.",
        });
      }

      const command = {
        id: crypto.randomUUID(),
        command: commandType,
        path: cleanString(data.path, 1000),
        createdAt: new Date().toISOString(),
      };

      if (
        (commandType === "wear" || commandType === "remove") &&
        !command.path
      ) {
        return response(400, {
          ok: false,
          error: "A path is required for this command.",
        });
      }

      session.commands.push(command);

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        commandId: command.id,
        message: "Command queued.",
      });
    }

    // Record the result returned by the HUD.
    if (action === "command_result") {
      const result = {
        id: cleanString(data.id || data.commandId, 100),
        success: Boolean(data.success),
        message: cleanString(data.message, 1000),
        completedAt: new Date().toISOString(),
      };

      session.commandResults.push(result);
      session.commandResults = session.commandResults.slice(-100);

      await saveSession(store, token, session);

      return response(200, {
        ok: true,
        message: "Command result saved.",
      });
    }

    return response(400, {
      ok: false,
      error: "Unknown POST action.",
    });
  } catch (error) {
    console.error("Closety HUD sync error:", error);

    return response(500, {
      ok: false,
      error: "Internal server error.",
    });
  }
}
