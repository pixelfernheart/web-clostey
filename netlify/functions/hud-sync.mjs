
import { getStore } from "@netlify/blobs";

const store = getStore("closety-wardrobes");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COMMAND_TTL_MS = 10 * 60 * 1000;

const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Cache-Control": "no-store",
};

function reply(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers,
  });
}

function cleanString(value, max = 500) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validToken(token) {
  return typeof token === "string" &&
    /^[a-zA-Z0-9-]{16,100}$/.test(token);
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

  return [...new Set(paths.map(normalizePath).filter(Boolean))];
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
  return (await store.get(key, { type: "json" })) ?? fallback;
}

async function writeJSON(key, value) {
  await store.setJSON(key, value);
}

async function getSession(token) {
  if (!validToken(token)) return null;

  const session = await readJSON(sessionKey(token));

  if (!session || Date.now() > session.expiresAt) return null;

  return session;
}

async function updateSession(token, changes) {
  const session = await getSession(token);
  if (!session) return null;

  const updated = {
    ...session,
    ...changes,
    updatedAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };

  await writeJSON(sessionKey(token), updated);
  return updated;
}

async function getCommands(token) {
  const items = await readJSON(commandsKey(token), []);
  const cutoff = Date.now() - COMMAND_TTL_MS;

  return Array.isArray(items)
    ? items.filter((item) => item.createdAt >= cutoff)
    : [];
}

async function handleGet(url) {
  const action = url.searchParams.get("action");
  const token = url.searchParams.get("token");

  if (!["state", "next_command"].includes(action)) {
    return reply({ error: "Unknown GET action." }, 400);
  }

  const session = await getSession(token);

  if (!session) {
    return reply({
      connected: false,
      error: "Pairing is invalid or expired. Connect the HUD again.",
    }, 401);
  }

  if (action === "state") {
    const folders = await readJSON(foldersKey(token), []);
    const results = await readJSON(resultsKey(token), []);
    const wornResult = [...results]
      .reverse()
      .find((item) => item.type === "worn_state");

    return reply({
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

  const commands = await getCommands(token);
  const next = commands.find((item) => item.status === "queued");

  if (!next) return reply({ ok: true, command: null });

  next.status = "delivered";
  next.deliveredAt = Date.now();
  await writeJSON(commandsKey(token), commands);

  return reply({
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

async function handlePost(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return reply({ ok: false, error: "Invalid JSON request." }, 400);
  }

  const action = cleanString(body.action, 40);
  const token = cleanString(body.token, 100);

  if (action === "pair") {
    if (!validToken(token)) {
      return reply({ ok: false, error: "Invalid pairing token." }, 400);
    }

    await writeJSON(foldersKey(token), []);
    await writeJSON(commandsKey(token), []);
    await writeJSON(resultsKey(token), []);

    await writeJSON(sessionKey(token), {
      token,
      avatarUUID: cleanString(body.avatarUUID, 100),
      avatarName: cleanString(body.avatarName, 100),
      scanStatus: "waiting",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL_MS,
    });

    return reply({ ok: true, connected: true });
  }

  const session = await getSession(token);

  if (!session) {
    return reply({
      ok: false,
      error: "Invalid or expired pairing. Connect the HUD again.",
    }, 401);
  }

  if (action === "scan_start") {
    await writeJSON(foldersKey(token), []);
    await updateSession(token, { scanStatus: "scanning" });
    return reply({ ok: true });
  }

  if (action === "sync_chunk") {
    const incoming = uniquePaths(body.paths);
    const existing = await readJSON(foldersKey(token), []);
    const merged = uniquePaths([
      ...(Array.isArray(existing) ? existing : []),
      ...incoming,
    ]);

    await writeJSON(foldersKey(token), merged);
    await updateSession(token, { scanStatus: "scanning" });

    return reply({
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

    return reply({
      ok: true,
      folderCount: Array.isArray(folders) ? folders.length : 0,
    });
  }

  if (action === "enqueue_command") {
    const command = body.command || {};
    const commandAction = cleanString(command.action, 30);
    const allowed = ["wear", "remove", "strip_all"];

    if (!allowed.includes(commandAction)) {
      return reply({ ok: false, error: "Unsupported command." }, 400);
    }

    const path = normalizePath(command.path);

    if (
      ["wear", "remove"].includes(commandAction) &&
      !path
    ) {
      return reply({ ok: false, error: "A folder path is required." }, 400);
    }

    if (path.split("/").some((part) => part === "." || part === "..")) {
      return reply({ ok: false, error: "Invalid folder path." }, 400);
    }

    // Verify the path belongs to the latest scanned WC folder list.
    if (commandAction !== "strip_all") {
      const folders = await readJSON(foldersKey(token), []);

      if (!Array.isArray(folders) || !folders.includes(path)) {
        return reply({
          ok: false,
          error: "That folder was not found in the latest scan.",
        }, 400);
      }
    }

    const commands = await getCommands(token);

    const duplicate = commands.find((item) =>
      item.status === "queued" &&
      item.action === commandAction &&
      item.path === path
    );

    if (duplicate) {
      return reply({ ok: true, commandId: duplicate.id });
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

    return reply({ ok: true, commandId: item.id });
  }

  if (action === "command_result") {
    const commandId = cleanString(body.commandId, 100);
    const commands = await getCommands(token);
    const command = commands.find((item) => item.id === commandId);

    const result = {
      type: "command_result",
      commandId,
      success: Boolean(body.success),
      message: cleanString(body.message, 500),
      completedAt: Date.now(),
    };

    if (command) {
      command.status = result.success ? "complete" : "failed";
      command.result = result;
      await writeJSON(commandsKey(token), commands);
    }

    const results = await readJSON(resultsKey(token), []);
    results.push(result);
    await writeJSON(resultsKey(token), results.slice(-50));

    return reply({ ok: true });
  }

  if (action === "worn_state") {
    const wornOutfits = Array.isArray(body.wornOutfits)
      ? body.wornOutfits.slice(0, 300).map((item) => {
          if (typeof item === "string") {
            return {
              name: item.split("/").pop(),
              path: normalizePath(item),
            };
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

    return reply({ ok: true });
  }

  return reply({ ok: false, error: "Unknown POST action." }, 400);
}

export default async function handler(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    if (request.method === "GET") {
      return await handleGet(new URL(request.url));
    }

    if (request.method === "POST") {
      let body;

      try {
        body = await request.json();
      } catch {
        return reply({ ok: false, error: "Invalid JSON request." }, 400);
      }

      return await handlePost(body);
    }

    return reply({ error: "Method not allowed." }, 405);
  } catch (error) {
    console.error("Closety HUD sync error:", error);

    return reply({
      ok: false,
      error: "Closety server error. Check the Netlify function logs.",
    }, 500);
  }
}
