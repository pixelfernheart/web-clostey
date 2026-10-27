import { useCallback, useEffect, useMemo, useState } from "react";

const API_URL = "/api/hud-sync";
const DB_NAME = "closety-local";
const DB_VERSION = 1;
const STORE_NAME = "images";

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAllImages() {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function putImage(record) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(record);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function deleteImage(id) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);

    transaction.oncomplete = () => {
      db.close();
      resolve();
    };

    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

function normalizePath(path) {
  return String(path || "")
    .replace(/^#?RLV[\\/]/i, "")
    .replace(/^WC[\\/]/i, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .join("/");
}

function getOutfits(paths) {
  const uniquePaths = [...new Set((paths || []).map(normalizePath))]
    .filter(Boolean);

  // For this first version, leaf folders are treated as outfit candidates.
  // A later HUD enhancement can identify loose objects and explicit outfit groups.
  return uniquePaths
    .filter(
      (path) =>
        !uniquePaths.some(
          (other) => other !== path && other.startsWith(`${path}/`)
        )
    )
    .map((path) => {
      const parts = path.split("/");
      return {
        id: path,
        path,
        name: parts[parts.length - 1],
        category: parts.length > 1
          ? parts.slice(0, -1).join(" / ")
          : "Wardrobe",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function buildTree(paths) {
  const root = { name: "#RLV/WC", children: {} };

  for (const originalPath of paths || []) {
    const parts = normalizePath(originalPath).split("/").filter(Boolean);
    let current = root;

    for (const part of parts) {
      if (!current.children[part]) {
        current.children[part] = { name: part, children: {} };
      }
      current = current.children[part];
    }
  }

  return root;
}

function Folder({ node, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth === 0);
  const children = Object.values(node.children || {}).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <div>
      <button
        className="folder-row"
        style={{ paddingLeft: `${14 + depth * 19}px` }}
        type="button"
        onClick={() => setExpanded((value) => !value)}
      >
        <span className="folder-arrow">
          {children.length ? (expanded ? "⌄" : "›") : "·"}
        </span>
        <span>{children.length ? "📁" : "🗂️"}</span>
        <span className="folder-title">{node.name}</span>
        {children.length > 0 && (
          <span className="folder-count">{children.length}</span>
        )}
      </button>

      {expanded &&
        children.map((child) => (
          <Folder key={child.name} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      resolve(dataUrl.split(",")[1] || "");
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function base64ToBlob(value, mimeType) {
  const binary = atob(value || "");
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], {
    type: mimeType || "image/png",
  });
}

function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function App() {
  const token = useMemo(
    () => new URLSearchParams(window.location.search).get("token"),
    []
  );

  const [connection, setConnection] = useState("checking");
  const [avatarName, setAvatarName] = useState("");
  const [scanStatus, setScanStatus] = useState("waiting");
  const [folders, setFolders] = useState([]);
  const [wornOutfits, setWornOutfits] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [images, setImages] = useState([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busyCommand, setBusyCommand] = useState("");

  const outfits = useMemo(() => getOutfits(folders), [folders]);
  const tree = useMemo(() => buildTree(folders), [folders]);

  const reloadImages = useCallback(async () => {
    try {
      setImages(await getAllImages());
    } catch (err) {
      console.error(err);
      setNotice("Could not load the local image library.");
    }
  }, []);

  const refreshWardrobe = useCallback(async () => {
    if (!token) {
      setConnection("disconnected");
      setError("Open the paired wardrobe link provided by your Closety HUD.");
      setRefreshing(false);
      return;
    }

    setRefreshing(true);
    setError("");

    try {
      const response = await fetch(
        `${API_URL}?action=state&token=${encodeURIComponent(token)}`,
        { cache: "no-store" }
      );

      const data = await response.json();

      if (!response.ok || !data.connected) {
        throw new Error(data.error || "The HUD pairing could not be verified.");
      }

      setConnection("connected");
      setAvatarName(data.avatarName || "Second Life avatar");
      setScanStatus(data.scanStatus || "waiting");
      setFolders(Array.isArray(data.folders) ? data.folders : []);
      setWornOutfits(Array.isArray(data.wornOutfits) ? data.wornOutfits : []);
      setLastUpdated(data.updatedAt ? new Date(data.updatedAt) : new Date());
      setNotice("Wardrobe refreshed.");
    } catch (err) {
      console.error(err);
      setConnection("error");
      setError(err.message || "Cannot reach the Closety server.");
    } finally {
      setRefreshing(false);
    }
  }, [token]);

  useEffect(() => {
    refreshWardrobe();
    reloadImages();
  }, [refreshWardrobe, reloadImages]);

  const filteredOutfits = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) return outfits;

    return outfits.filter((outfit) =>
      `${outfit.name} ${outfit.category} ${outfit.path}`
        .toLowerCase()
        .includes(term)
    );
  }, [outfits, search]);

  function getImage(outfit) {
    return (
      images.find((image) => image.id === outfit.id) ||
      images.find(
        (image) =>
          image.imageName?.trim().toLowerCase() ===
          outfit.name.trim().toLowerCase()
      )
    );
  }

  async function uploadImage(outfit, file) {
    if (!file) return;

    const allowed = ["image/jpeg", "image/png", "image/webp"];

    if (!allowed.includes(file.type)) {
      setNotice("Please choose a JPEG, PNG, or WebP image.");
      return;
    }

    const name = window.prompt(
      "Image name (leave blank to use the outfit name):",
      outfit.name
    );

    if (name === null) return;

    try {
      await putImage({
        id: outfit.id,
        outfitPath: outfit.path,
        outfitName: outfit.name,
        imageName: name.trim() || outfit.name,
        mimeType: file.type,
        blob: file,
        updatedAt: Date.now(),
      });

      await reloadImages();
      setNotice(`Saved the preview image for ${outfit.name}.`);
    } catch (err) {
      console.error(err);
      setNotice("Could not save the image to local browser storage.");
    }
  }

  async function removePreview(outfit) {
    if (!window.confirm(`Remove the preview image for "${outfit.name}"?`)) {
      return;
    }

    await deleteImage(outfit.id);
    await reloadImages();
    setNotice("Preview image removed.");
  }

  async function exportImageLibrary() {
    try {
      const records = await getAllImages();
      const exported = [];

      for (const record of records) {
        exported.push({
          id: record.id,
          outfitPath: record.outfitPath || record.id,
          outfitName: record.outfitName || "",
          imageName: record.imageName || "",
          mimeType: record.mimeType || record.blob?.type || "image/png",
          updatedAt: record.updatedAt || Date.now(),
          base64: record.blob ? await fileToBase64(record.blob) : "",
        });
      }

      downloadJSON(
        {
          format: "closety-image-library",
          version: 1,
          exportedAt: new Date().toISOString(),
          images: exported,
        },
        "closety-images.json"
      );

      setNotice(`Exported ${exported.length} image(s).`);
    } catch (err) {
      console.error(err);
      setNotice("Image library export failed.");
    }
  }

  async function importImageLibrary(file) {
    if (!file) return;

    try {
      const data = JSON.parse(await file.text());

      if (
        data.format !== "closety-image-library" ||
        !Array.isArray(data.images)
      ) {
        throw new Error("That file is not a Closety image-library backup.");
      }

      for (const record of data.images) {
        if (!record || typeof record.id !== "string") continue;

        await putImage({
          id: record.id,
          outfitPath: record.outfitPath || record.id,
          outfitName: record.outfitName || "",
          imageName: record.imageName || record.outfitName || "",
          mimeType: record.mimeType || "image/png",
          updatedAt: record.updatedAt || Date.now(),
          blob: base64ToBlob(record.base64, record.mimeType),
        });
      }

      await reloadImages();
      setNotice(`Imported ${data.images.length} image record(s).`);
    } catch (err) {
      console.error(err);
      setNotice(`Import failed: ${err.message || "Invalid JSON file."}`);
    }
  }

  async function sendCommand(action, outfit = null) {
    if (!token) {
      setNotice("Connect the HUD before sending wardrobe commands.");
      return;
    }

    if (action === "strip_all") {
      const confirmed = window.confirm(
        "Strip all items managed by Closety inside #RLV/WC? Items outside that folder should not be affected."
      );

      if (!confirmed) return;
    }

    const command = {
      action,
      path: outfit?.path || "",
      outfitName: outfit?.name || "",
      requestedAt: new Date().toISOString(),
    };

    setBusyCommand(outfit ? `${action}:${outfit.id}` : action);
    setNotice("");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enqueue_command",
          token,
          command,
        }),
      });

      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "The command could not be queued.");
      }

      setNotice(
        `${action.replaceAll("_", " ").toUpperCase()} queued. Keep the Closety HUD attached in Second Life.`
      );
    } catch (err) {
      console.error(err);
      setNotice(
        `Command not sent: ${err.message}. The command API must be deployed before these buttons can work.`
      );
    } finally {
      setBusyCommand("");
    }
  }

  const statusText = !token
    ? "HUD NOT CONNECTED"
    : connection === "checking"
      ? "CHECKING"
      : connection === "error" || connection === "disconnected"
        ? "CONNECTION ERROR"
        : scanStatus === "complete"
          ? "HUD CONNECTED"
          : scanStatus === "scanning"
            ? "SCANNING"
            : "PAIRED · WAITING FOR SCAN";

  const statusClass =
    connection === "connected"
      ? scanStatus === "complete"
        ? "online"
        : "pending"
      : "offline";

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top">
          <span className="brand-logo">C</span>
          <span>
            <strong>closety</strong>
            <small>YOUR VIRTUAL WARDROBE</small>
          </span>
        </a>

        <div className="sidebar-label">WARDROBE</div>
        <a className="nav-link active" href="#outfits">▦ <span>My Closet</span></a>
        <a className="nav-link" href="#wearing">♙ <span>Currently Wearing</span></a>
        <a className="nav-link" href="#folders">▤ <span>Folder Structure</span></a>

        <div className="sidebar-bottom">
          <div className="avatar-badge">SL</div>
          <div className="sidebar-avatar-text">
            <strong>Second Life</strong>
            <small>{avatarName || "HUD connection"}</small>
          </div>
          <span className={`tiny-status ${connection === "connected" ? "green" : ""}`} />
        </div>
      </aside>

      <main className="main-content" id="top">
        <header className="topbar">
          <span className="breadcrumb">My Closet <span>/</span> Overview</span>
          <span className="privacy-badge">🔒 PRIVATE WARDROBE</span>
        </header>

        <div className="page-content">
          <section className="hero">
            <div>
              <div className="eyebrow">YOUR SPACE. YOUR STYLE.</div>
              <h1>Your closet, <span>your way.</span></h1>
              <p>One organised home for your Second Life wardrobe.</p>
            </div>
            <div className="hero-decoration" aria-hidden="true">✳</div>
          </section>

          <section className="connection-panel">
            <div className="connection-symbol">⌘</div>
            <div className="connection-copy">
              <small>SECOND LIFE INTEGRATION</small>
              <h2>Closety HUD</h2>
              <p>
                {avatarName
                  ? `Paired with ${avatarName}`
                  : "Attach your existing Closety HUD and connect your wardrobe."}
              </p>
            </div>
            <div className="connection-controls">
              <span className={`status-pill ${statusClass}`}>
                <i /> {statusText}
              </span>
              <button
                className="button primary"
                type="button"
                onClick={refreshWardrobe}
                disabled={refreshing}
              >
                {refreshing ? "Refreshing…" : "↻ Refresh"}
              </button>
            </div>
          </section>

          {error && <div className="alert error-alert">{error}</div>}
          {notice && (
            <div className="alert notice-alert">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")} aria-label="Dismiss">×</button>
            </div>
          )}

          <section className="stats-grid">
            <article className="stat-card">
              <span className="stat-icon">▤</span>
              <small>OUTFIT CANDIDATES</small>
              <strong>{outfits.length}</strong>
              <p>Discovered from leaf folders</p>
            </article>
            <article className="stat-card">
              <span className="stat-icon purple">⌁</span>
              <small>PREVIEW IMAGES</small>
              <strong>{images.length}</strong>
              <p>Saved locally in this browser</p>
            </article>
            <article className="stat-card">
              <span className="stat-icon">◷</span>
              <small>LAST REFRESH</small>
              <strong className="last-refresh">
                {lastUpdated
                  ? lastUpdated.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </strong>
              <p>Refresh manually when needed</p>
            </article>
          </section>

          <section className="section-block" id="outfits">
            <div className="section-header">
              <div>
                <div className="eyebrow">YOUR COLLECTION</div>
                <h2>Outfit cards</h2>
                <p>Choose a preview image and manage each discovered outfit.</p>
              </div>
              <div className="backup-actions">
                <button className="button secondary" type="button" onClick={exportImageLibrary}>
                  ↓ Export JSON
                </button>
                <label className="button secondary file-button">
                  ↑ Import JSON
                  <input
                    type="file"
                    accept=".json,application/json"
                    onChange={(event) => {
                      importImageLibrary(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </label>
              </div>
            </div>

            <div className="outfit-toolbar">
              <label className="search-field">
                <span>⌕</span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search outfits and categories…"
                  aria-label="Search outfits and categories"
                />
              </label>
              <span className="result-count">{filteredOutfits.length} outfits</span>
            </div>

            {filteredOutfits.length ? (
              <div className="outfit-grid">
                {filteredOutfits.map((outfit) => {
                  const image = getImage(outfit);
                  const imageURL = image?.blob ? URL.createObjectURL(image.blob) : "";

                  return (
                    <article className="outfit-card" key={outfit.id}>
                      <div className="outfit-image">
                        {imageURL ? (
                          <img
                            src={imageURL}
                            alt={image.imageName || outfit.name}
                            onLoad={() => URL.revokeObjectURL(imageURL)}
                          />
                        ) : (
                          <div className="image-placeholder">
                            <span>✳</span>
                            <small>ADD YOUR OUTFIT IMAGE</small>
                          </div>
                        )}
                        <label className="img-button">
                          IMG +
                          <input
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            onChange={(event) => {
                              uploadImage(outfit, event.target.files?.[0]);
                              event.target.value = "";
                            }}
                          />
                        </label>
                      </div>

                      <div className="outfit-info">
                        <small className="category-label">{outfit.category}</small>
                        <h3>{outfit.name}</h3>
                        <p className="path-label">{outfit.path}</p>
                        {image && (
                          <p className="image-label">
                            Image name: {image.imageName || outfit.name}
                          </p>
                        )}

                        <div className="outfit-buttons">
                          <button
                            className="button wear-button"
                            type="button"
                            disabled={Boolean(busyCommand)}
                            onClick={() => sendCommand("wear", outfit)}
                          >
                            {busyCommand === `wear:${outfit.id}` ? "SENDING…" : "WEAR"}
                          </button>
                          <button
                            className="button remove-button"
                            type="button"
                            disabled={Boolean(busyCommand)}
                            onClick={() => sendCommand("remove", outfit)}
                          >
                            {busyCommand === `remove:${outfit.id}` ? "SENDING…" : "REMOVE"}
                          </button>
                        </div>

                        {image && (
                          <button
                            className="remove-image-link"
                            type="button"
                            onClick={() => removePreview(outfit)}
                          >
                            Remove preview image
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">
                <span>📂</span>
                <h3>{folders.length ? "No matching outfits" : "Your closet is waiting"}</h3>
                <p>
                  {folders.length
                    ? "Try a different search."
                    : "Use CONNECT and SCAN in your in-world HUD, then click Refresh."}
                </p>
              </div>
            )}

            <div className="strip-panel">
              <div>
                <h3>Strip all Closety outfits</h3>
                <p>Only wardrobe items managed under #RLV/WC should be affected.</p>
              </div>
              <button
                className="button strip-button"
                type="button"
                disabled={Boolean(busyCommand)}
                onClick={() => sendCommand("strip_all")}
              >
                {busyCommand === "strip_all" ? "SENDING…" : "STRIP ALL"}
              </button>
            </div>
          </section>

          <section className="section-block" id="wearing">
            <div className="section-header">
              <div>
                <div className="eyebrow">AVATAR STATUS</div>
                <h2>Currently Wearing</h2>
                <p>Items and outfits reported by the in-world HUD.</p>
              </div>
              <span className="result-count">
                {wornOutfits.length} reported
              </span>
            </div>

            {wornOutfits.length ? (
              <div className="outfit-grid">
                {wornOutfits.map((worn, index) => {
                  const path = typeof worn === "string" ? worn : worn.path;
                  const outfit = outfits.find((item) => item.path === normalizePath(path));
                  const name = typeof worn === "string" ? path.split("/").pop() : worn.name;

                  return (
                    <article className="wearing-card" key={`${path}-${index}`}>
                      <div className="wearing-mark">✓</div>
                      <div>
                        <strong>{name || "Worn outfit"}</strong>
                        <small>{path}</small>
                      </div>
                      <button
                        className="button remove-button"
                        type="button"
                        onClick={() => outfit
                          ? sendCommand("remove", outfit)
                          : sendCommand("remove", { path, name })}
                      >
                        REMOVE
                      </button>
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state compact-empty">
                <span>♙</span>
                <h3>No live worn-state data yet</h3>
                <p>
                  The fresh HUD script will need to report supported RLV status
                  back to the server before this section can show confirmed results.
                </p>
              </div>
            )}
          </section>

          <section className="section-block" id="folders">
            <div className="section-header">
              <div>
                <div className="eyebrow">INVENTORY OVERVIEW</div>
                <h2>Folder structure</h2>
                <p>Paths discovered by the HUD scan.</p>
              </div>
              <span className="result-count">{folders.length} folders</span>
            </div>

            {folders.length ? (
              <div className="folder-panel">
                <Folder node={tree} />
              </div>
            ) : (
              <div className="empty-state compact-empty">
                <span>📁</span>
                <h3>No folders received yet</h3>
                <p>Connect and scan using your HUD, then click Refresh.</p>
              </div>
            )}

            <p className="inventory-note">
              The existing scan discovers folder paths. It does not yet identify
              loose wearable objects or verify exactly which items are worn.
            </p>
          </section>

          <footer className="page-footer">
            <span>closety <b>♥</b> made for your Second Life wardrobe</span>
            <span>LOCAL IMAGE LIBRARY · #RLV/WC</span>
          </footer>
        </div>
      </main>
    </div>
  );
}