import { getStore } from "@netlify/blobs";

const STORE_NAME = "closety-wardrobes";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMMAND_TTL_MS = 10 * 60 * 1000;

const store = getStore(STORE_NAME);

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};

function reply(statusCode, data) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(data),
  };
}

function readBody(event) {
  try {
    return JSON.parse(event.body || "{}");
  } catch {
    return null;
  }
}

function cleanString(value, maxLength = 500) {
  return typeof value === "string"
    ? value.trim().slice(0, maxLength)
    : "";
}

function normalizePath(value) {
  return cleanString(value, 1000)
    .replace(/^#?RLV[\\/]/i, "")
    .replace(/^WC[\\/]/i, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .join("/");
}

function uniquePaths(paths) {
  if (!Array.isArray(paths)) return [];

  return [
    ...new Set(
      paths
        .map(normalizePath)
        .filter(Boolean)
    ),
  ];
}

function isValidToken(token) {
  return typeof token === "string" &&
    /^[a-zA-Z0-9-]{16,100}$/.test(token);
}

function sessionKey(token) {
  return `session:${token}`;
}

function foldersKey(token) {
  return `folders:${token}`;
}

function commandsKey(token) {
  return `commands:${token}`;
}

function resultsKey(token) {
  return `results:${token}`;
}

async function readJSON(key, fallback = null) {
  const value = await store.get(key, { type: "json" });
  return value ?? fallback;
}

async function writeJSON(key, value) {
  await store.setJSON(key, value);
}

async function getValidSession(token) {
  if (!isValidToken(token)) return null;

  const session = await readJSON(sessionKey(token));

  if (!session) return null;

  if (!session.expiresAt || Date.now() > session.expiresAt) {
    return null;
  }

  return session;
}

async function updateSession(token, changes) {
  const current = await getValidSession(token);

  if (!current) return null;

  const updated = {
    ...current,
    ...changes,
    updatedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  await writeJSON(sessionKey(token), updated);
  return updated;
}

async function getCommands(token) {
  const commands = await readJSON(commandsKey(token), []);
  const cutoff = Date.now() - COMMAND_TTL_MS;

  return Array.isArray(commands)
    ? commands.filter((command) => command.createdAt >= cutoff)
    : [];
}

async function handleGet(event) {
  const params = new URLSearchParams(event.queryStringParameters || {});
  const action = params.get("action");
  const token = params.get("token");

  if (action !== "state" && action !== "next_command") {
    return reply(400, { error: "Unknown GET action." });
  }

  const session = await getValidSession(token);

  if (!session) {
    return reply(401, {
      connected: false,
      error: "This pairing is invalid or expired. Connect the HUD again.",
    });
  }

  if (action === "state") {
    const folders = await readJSON(foldersKey(token), []);
    const results = await readJSON(resultsKey(token), []);
    const wornResult = [...results]
      .reverse()
      .find((result) => result.type === "worn_state");

    return reply(200, {
      connected: true,
      avatarName: session.avatarName || "",
      avatarUUID: session.avatarUUID || "",
      scanStatus: session.scanStatus || "waiting",
      folders: Array.isArray(folders) ? folders : [],
      wornOutfits: wornResult?.wornOutfits || [],
      updatedAt: session.updatedAt || null,
      lastCommandResult: results.at(-1) || null,
    });
  }

  // The HUD can retrieve the oldest unclaimed command.
  const commands = await getCommands(token);
  const next = commands.find((command) => command.status === "queued");

  if (!next) {
    return reply(200, { ok: true, command: null });
  }

  next.status = "delivered";
  next.deliveredAt = Date.now();

  await writeJSON(commandsKey(token), commands);

  return reply(200, {
    ok: true,
    command: {
      id: next.id,
      action: next.action,
      path: next.path || "",
      outfitName: next.outfitName || "",
      createdAt: next.createdAt,
    },
  });
}

async function handlePost(event) {
  const body = readBody(event);

  if (!body) {
    return reply(400, { ok: false, error: "Invalid JSON request." });
  }

  const action = cleanString(body.action, 40);
  const token = cleanString(body.token, 100);

  if (action === "pair") {
    if (!isValidToken(token)) {
      return reply(400, { ok: false, error: "Invalid pairing token." });
    }

    const avatarUUID = cleanString(body.avatarUUID, 100);
    const avatarName = cleanString(body.avatarName, 100);

    await writeJSON(foldersKey(token), []);
    await writeJSON(commandsKey(token), []);
    await writeJSON(resultsKey(token), []);

    await writeJSON(sessionKey(token), {
      token,
      avatarUUID,
      avatarName,
      scanStatus: "waiting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    return reply(200, { ok: true, connected: true });
  }

  const session = await getValidSession(token);

  if (!session) {
    return reply(401, {
      ok: false,
      error: "Invalid or expired pairing. Connect the HUD again.",
    });
  }

  if (action === "scan_start") {
    await writeJSON(foldersKey(token), []);

    await updateSession(token, {
      scanStatus: "scanning",
    });

    return reply(200, { ok: true });
  }

  if (action === "sync_chunk") {
    const incoming = uniquePaths(body.paths);
    const existing = await readJSON(foldersKey(token), []);
    const merged = uniquePaths([
      ...(Array.isArray(existing) ? existing : []),
      ...incoming,
    ]);

    // Store folder paths separately from session metadata.
    await writeJSON(foldersKey(token), merged);
    await updateSession(token, {
      scanStatus: "scanning",
    });

    return reply(200, {
      ok: true,
      received: incoming.length,
      total: merged.length,
    });
  }

  if (action === "scan_finish") {
    const folders = await readJSON(foldersKey(token), []);

    await updateSession(token, {
      scanStatus: "complete",
      folderCount: Array.isArray(folders) ? folders.length : 0,
    });

    return reply(200, {
      ok: true,
      folderCount: Array.isArray(folders) ? folders.length : 0,
    });
  }

  if (action === "enqueue_command") {
    const command = body.command || {};
    const commandAction = cleanString(command.action, 30);
    const allowedActions = new Set(["wear", "remove", "strip_all"]);

    if (!allowedActions.has(commandAction)) {
      return reply(400, {
        ok: false,
        error: "Unsupported wardrobe command.",
      });
    }

    const path = normalizePath(command.path);

    if (
      (commandAction === "wear" || commandAction === "remove") &&
      !path
    ) {
      return reply(400, {
        ok: false,
        error: "A valid wardrobe folder path is required.",
      });
    }

    // Do not permit paths that escape the managed #RLV/WC root.
    if (
      path.split("/").some((part) => part === "." || part === "..")
    ) {
      return reply(400, {
        ok: false,
        error: "Invalid wardrobe path.",
      });
    }

    const commands = await getCommands(token);

    // Prevent repeated clicks from queuing the same still-pending command.
    const duplicate = commands.find(
      (item) =>
        item.status === "queued" &&
        item.action === commandAction &&
        item.path === path
    );

    if (duplicate) {
      return reply(200, { ok: true, commandId: duplicate.id });
    }

    const item = {
      id: crypto.randomUUID(),
      action: commandAction,
      path,
      outfitName: cleanString(command.outfitName, 200),
      status: "queued",
      createdAt: Date.now(),
    };

    commands.push(item);
    await writeJSON(commandsKey(token), commands);

    return reply(200, {
      ok: true,
      commandId: item.id,
    });
  }

  if (action === "command_result") {
    const result = {
      type: "command_result",
      commandId: cleanString(body.commandId, 100),
      success: Boolean(body.success),
      message: cleanString(body.message, 500),
      completedAt: Date.now(),
    };

    const commands = await getCommands(token);
    const command = commands.find((item) => item.id === result.commandId);

    if (command) {
      command.status = result.success ? "complete" : "failed";
      command.result = result;
      await writeJSON(commandsKey(token), commands);
    }

    const results = await readJSON(resultsKey(token), []);
    results.push(result);
    await writeJSON(resultsKey(token), results.slice(-50));

    return reply(200, { ok: true });
  }

  if (action === "worn_state") {
    const wornOutfits = Array.isArray(body.wornOutfits)
      ? body.wornOutfits.slice(0, 300).map((item) => {
          if (typeof item === "string") {
            return { name: item.split("/").pop(), path: normalizePath(item) };
          }

          return {
            name: cleanString(item?.name, 200),
            path: normalizePath(item?.path),
          };
        })
      : [];

    const results = await readJSON(resultsKey(token), []);

    results.push({
      type: "worn_state",
      wornOutfits,
      updatedAt: Date.now(),
    });

    await writeJSON(resultsKey(token), results.slice(-50));
    await updateSession(token, { wornStateUpdatedAt: Date.now() });

    return reply(200, { ok: true });
  }

  return reply(400, {
    ok: false,
    error: "Unknown POST action.",
  });
}

export default async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: "",
    };
  }

  try {
    if (event.httpMethod === "GET") {
      return await handleGet(event);
    }

    if (event.httpMethod === "POST") {
      return await handlePost(event);
    }

    return reply(405, { error: "Method not allowed." });
  } catch (error) {
    console.error("Closety HUD sync error:", error);

    return reply(500, {
      ok: false,
      connected: false,
      error: "Closety server error. Check the Netlify function logs.",
    });
  }
}