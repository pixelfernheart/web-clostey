import { useCallback, useEffect, useMemo, useState } from "react";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import "./style.css";

const API_URL = "/api/hud-sync";
const DB_NAME = "closety-local";
const DB_VERSION = 1;
const STORE_NAME = "images";

/* ---------------------------------------------------------------
   IndexedDB image storage (unchanged)
---------------------------------------------------------------- */

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) {
      reject(new Error("This browser does not support local image storage."));
      return;
    }
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
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function putImage(record) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("Save cancelled.")); };
  });
}

async function deleteImage(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
    tx.onabort = () => { db.close(); reject(tx.error || new Error("Delete cancelled.")); };
  });
}

/* ---------------------------------------------------------------
   Helpers
---------------------------------------------------------------- */

function normalizePath(path) {
  return String(path || "")
    .replace(/^#?RLV[\\/]/i, "")
    .replace(/^WC[\\/]/i, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .join("/");
}

function buildTree(paths) {
  const root = { name: "My Closet", path: "", children: {}, isLeaf: false };
  for (const originalPath of paths || []) {
    const parts = normalizePath(originalPath).split("/").filter(Boolean);
    let current = root;
    let currentPath = "";
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      const isLast = i === parts.length - 1;
      if (!current.children[part]) {
        current.children[part] = {
          name: part,
          path: currentPath,
          children: {},
          isLeaf: true,
        };
      }
      current = current.children[part];
      if (!isLast) current.isLeaf = false;
    }
  }
  return root;
}

const sortedChildren = (node) =>
  Object.values(node?.children || {}).sort((a, b) => a.name.localeCompare(b.name));

const isFolder = (node) => !node.isLeaf;
const countItemsAndFolders = (node) => Object.keys(node?.children || {}).length;

function nodeToOutfit(node) {
  const parts = node.path.split("/");
  return {
    id: node.path,
    path: node.path,
    name: node.name,
    category: parts.length > 1 ? parts.slice(0, -1).join(" / ") : "Wardrobe",
  };
}

function collectOutfits(node, list = []) {
  for (const child of sortedChildren(node)) {
    if (isFolder(child)) collectOutfits(child, list);
    else list.push(nodeToOutfit(child));
  }
  return list;
}

function findNode(tree, path) {
  if (!path) return tree;
  let current = tree;
  for (const part of path.split("/")) {
    current = current.children[part];
    if (!current) return null;
  }
  return current;
}

function parentPathOf(path) {
  if (!path) return "";
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function base64ToBlob(value, mimeType) {
  const binary = atob(value || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType || "image/png" });
}

/* ---- Image compression: fit inside 600x750, JPEG, aim for <= 150 KB ---- */
const IMG_MAX_W = 480;
const IMG_MAX_H = 600;
const IMG_TARGET_BYTES = 150 * 1024;

async function canvasToBlob(canvas, quality) {
  // Prefer WebP (smaller). Some browsers can't encode it and return PNG instead, so fall back to JPEG.
  const webp = await new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (webp && webp.type === "image/webp") return webp;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  // Only ever scales down, never up.
  let scale = Math.min(1, IMG_MAX_W / width, IMG_MAX_H / height);
  let blob = null;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // PNG/WebP transparency -> white
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    let quality = 0.8;
    blob = await canvasToBlob(canvas, quality);
    while (blob && blob.size > IMG_TARGET_BYTES && quality > 0.6) {
      quality = Math.round((quality - 0.05) * 100) / 100;
      blob = await canvasToBlob(canvas, quality);
    }
    if (blob && blob.size <= IMG_TARGET_BYTES) break;
    scale *= 0.85; // still too big: shrink dimensions and retry
  }

  if (typeof bitmap.close === "function") bitmap.close();
  if (!blob) throw new Error("Could not compress that image.");
  return blob;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function samePath(a, b) {
  return (
    String(a || "").replace(/\/+$/, "").toLowerCase() ===
    String(b || "").replace(/\/+$/, "").toLowerCase()
  );
}

/* ---------------------------------------------------------------
   Components
---------------------------------------------------------------- */

function FolderTree({ node, depth = 0, selectedPath, onSelect, defaultExpanded = false }) {
  const allChildren = sortedChildren(node);
  const folderChildren = allChildren.filter(isFolder);
  const [expanded, setExpanded] = useState(defaultExpanded || depth < 1);

  const selected = node.path === selectedPath;
  const hasAnyChildren = allChildren.length > 0;
  const totalCount = countItemsAndFolders(node);

  if (depth > 0 && !hasAnyChildren) return null;

  return (
    <div className="tree-node">
      <div className={`folder-row ${selected ? "selected" : ""}`} style={{ "--depth": depth }}>
        <button
          className="folder-expand"
          type="button"
          onClick={() => folderChildren.length > 0 && setExpanded((v) => !v)}
          aria-label={expanded ? "Collapse folder" : "Expand folder"}
          disabled={folderChildren.length === 0}
        >
          {folderChildren.length > 0 ? (expanded ? "⌄" : "›") : ""}
        </button>

        <button className="folder-select" type="button" onClick={() => onSelect(node.path)}>
          <span className="folder-icon">{hasAnyChildren ? "📁" : "🗂️"}</span>
          <span className="folder-title">{node.name}</span>
          {hasAnyChildren && <span className="folder-count">{totalCount}</span>}
        </button>
      </div>

      {expanded &&
        folderChildren.map((child) => (
          <FolderTree
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

function ImagePreview({ image, alt }) {
  const [url, setUrl] = useState("");

  useEffect(() => {
    if (!image?.blob) { setUrl(""); return undefined; }
    const objectUrl = URL.createObjectURL(image.blob);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [image?.blob]);

  if (!url) {
    return (
      <div className="image-placeholder">
        <span className="placeholder-sparkle">✳</span>
        <small>ADD YOUR OUTFIT IMAGE</small>
      </div>
    );
  }
  return <img src={url} alt={alt} />;
}

/* Button is disabled ONLY while the POST is in flight (busyCommand).
   It NEVER reads server state to decide its label — it uses `isWorn`
   which reflects the local, optimistic worn list. Click Wear →
   `isWorn` flips immediately in the parent, so this component
   re-renders as Remove on the same tick. No "REMOVING…" flash. */
function OutfitCard({ outfit, image, busyCommand, isWorn, onPickFile, onRemoveImage, onCommand }) {
  const key = outfit.id;
  const busyWear = busyCommand === `wear:${key}`;
  const busyRemove = busyCommand === `remove:${key}`;
  const disabled = busyWear || busyRemove;

  const label = isWorn
    ? busyRemove ? "REMOVING…" : "Remove"
    : busyWear ? "WEARING…" : "Wear";

  return (
    <article className={`outfit-card ${isWorn ? "is-worn" : ""}`}>
      <div className="outfit-image">
        <ImagePreview image={image} alt={outfit.name} />
        {isWorn && <span className="worn-badge">WORN</span>}
        {image && (
          <button
            className="remove-image-link"
            type="button"
            title="Remove preview image"
            aria-label="Remove preview image"
            onClick={() => onRemoveImage(outfit)}
          >
            ×
          </button>
        )}
        <label className="img-button">
          <span>＋</span> Add image
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              onPickFile(outfit, event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </label>
      </div>

      <div className="outfit-info">
        <small className="category-label">{outfit.category}</small>
        <h3 title={outfit.name}>{outfit.name}</h3>
        <p className="path-label" title={outfit.path}>{outfit.path}</p>

        <div className="outfit-buttons">
          <button
            className={`button ${isWorn ? "remove-button" : "wear-button"}`}
            type="button"
            disabled={disabled}
            onClick={() => onCommand(isWorn ? "remove" : "wear", outfit)}
          >
            {label}
          </button>
        </div>
      </div>
    </article>
  );
}

function WornCard({ item, image, busyCommand, onJumpToCloset, onCommand }) {
  const key = item.path;
  const busyRemove = busyCommand === `remove:${key}`;

  return (
    <article className="outfit-card is-worn worn-card">
      <button
        className="worn-card-jump"
        type="button"
        onClick={() => onJumpToCloset(item.path)}
        title="Show in My Closet"
      >
        <span className="worn-card-jump-label">Show in closet ↗</span>
      </button>

      <div className="outfit-image">
        <ImagePreview image={image} alt={item.name} />
        <span className="worn-badge">WORN</span>
      </div>

      <div className="outfit-info">
        <small className="category-label">{item.category}</small>
        <h3 title={item.name}>{item.name}</h3>
        <p className="path-label" title={item.path}>{item.path}</p>

        <div className="outfit-buttons">
          <button
            className="button remove-button"
            type="button"
            disabled={busyRemove}
            onClick={() => onCommand("remove", { ...item, id: item.path })}
          >
            {busyRemove ? "REMOVING…" : "Remove"}
          </button>
        </div>
      </div>
    </article>
  );
}

function ImageNameModal({ outfit, file, onSave, onCancel }) {
  const [mode, setMode] = useState("fetch");
  const [customName, setCustomName] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const finalName = mode === "fetch" ? outfit.name : customName.trim();
  const canSave = Boolean(finalName);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-label="Name your image"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <small>PREVIEW IMAGE</small>
            <h3>Name your image</h3>
          </div>
          <button className="modal-close" type="button" onClick={onCancel} aria-label="Close">×</button>
        </div>

        <div className="modal-body">
          {previewUrl && <img className="modal-preview" src={previewUrl} alt="Selected" />}

          <div className="modal-options">
            <label className={`modal-option ${mode === "fetch" ? "active" : ""}`}>
              <input
                type="radio"
                name="image-name-mode"
                checked={mode === "fetch"}
                onChange={() => setMode("fetch")}
              />
              <span className="modal-option-copy">
                <strong>Use the outfit name</strong>
                <small>{outfit.name}</small>
              </span>
            </label>

            <label className={`modal-option ${mode === "manual" ? "active" : ""}`}>
              <input
                type="radio"
                name="image-name-mode"
                checked={mode === "manual"}
                onChange={() => setMode("manual")}
              />
              <span className="modal-option-copy">
                <strong>Write a name</strong>
                <small>Type your own image name</small>
              </span>
            </label>

            {mode === "manual" && (
              <input
                className="modal-input"
                value={customName}
                onChange={(event) => setCustomName(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter" && canSave) onSave(finalName); }}
                placeholder="Image name"
                aria-label="Image name"
                autoFocus
              />
            )}
          </div>
        </div>

        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" disabled={!canSave} onClick={() => onSave(finalName)}>
            Save image
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({ title, message, confirmLabel, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onCancel(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal-card modal-small"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-header">
          <div>
            <small>PLEASE CONFIRM</small>
            <h3>{title}</h3>
          </div>
          <button className="modal-close" type="button" onClick={onCancel} aria-label="Close">×</button>
        </div>
        <p className="modal-message">{message}</p>
        <div className="modal-actions">
          <button className="button secondary" type="button" onClick={onCancel}>Cancel</button>
          <button className="button primary" type="button" onClick={onConfirm}>{confirmLabel || "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   App
---------------------------------------------------------------- */

export default function App() {
  const token = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("token") || localStorage.getItem("closety-token") || "";
  }, []);

  useEffect(() => {
    const urlToken = new URLSearchParams(window.location.search).get("token");
    if (urlToken) localStorage.setItem("closety-token", urlToken);
  }, []);

  const [connection, setConnection] = useState("checking");
  const [avatarName, setAvatarName] = useState("");
  const [scanStatus, setScanStatus] = useState("waiting");
  const [folders, setFolders] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [images, setImages] = useState([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [busyCommand, setBusyCommand] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [pendingUpload, setPendingUpload] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [wornOutfits, setWornOutfits] = useState([]);
  const [theme, setTheme] = useState(() => localStorage.getItem("closety-theme") || "light");
  const [activeTab, setActiveTab] = useState("closet");

  const tree = useMemo(() => buildTree(folders), [folders]);
  const allOutfits = useMemo(() => collectOutfits(tree), [tree]);

  useEffect(() => {
    localStorage.setItem("closety-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const reloadImages = useCallback(async () => {
    try {
      setImages(await getAllImages());
    } catch (err) {
      console.error(err);
      setNotice("Could not load the local image library.");
    }
  }, []);

  /* Single fetch triggered by: page load, Refresh button, or (optionally)
     tab focus. Never triggered by a Wear/Remove click. */
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
        `${API_URL}?action=status&token=${encodeURIComponent(token)}`,
        { method: "GET", cache: "no-store" }
      );
      const data = await response.json();

      if (!response.ok || !data.connected) {
        throw new Error(data.error || "The HUD pairing could not be verified.");
      }

      setConnection("connected");
      setAvatarName(data.avatarName || "Second Life avatar");
      setScanStatus(data.scanStatus || "waiting");
      setFolders(Array.isArray(data.folders) ? data.folders : []);
      setWornOutfits(Array.isArray(data.wornState) ? data.wornState : []);
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

  // Initial mount only. This is the ONLY automatic fetch.
  useEffect(() => {
    refreshWardrobe();
    reloadImages();
  }, [refreshWardrobe, reloadImages]);

  const selectedNode = useMemo(() => findNode(tree, selectedPath), [tree, selectedPath]);

  useEffect(() => {
    if (selectedPath && !selectedNode) setSelectedPath("");
  }, [selectedPath, selectedNode]);

  const searchTerm = search.trim().toLowerCase();
  const isSearching = Boolean(searchTerm);

  const folderCards = useMemo(
    () => (selectedNode ? sortedChildren(selectedNode).filter(isFolder) : []),
    [selectedNode]
  );

  const visibleOutfits = useMemo(() => {
    if (!selectedNode) return [];
    if (isSearching) {
      return allOutfits.filter((outfit) => {
        const inFolder = !selectedPath || outfit.path.startsWith(`${selectedPath}/`);
        const matches = `${outfit.name} ${outfit.category} ${outfit.path}`
          .toLowerCase()
          .includes(searchTerm);
        return inFolder && matches;
      });
    }
    return sortedChildren(selectedNode).filter((child) => !isFolder(child)).map(nodeToOutfit);
  }, [selectedNode, isSearching, searchTerm, allOutfits, selectedPath]);

  const wornNow = useMemo(() => {
    if (!wornOutfits.length) return [];
    return wornOutfits.map((path) => {
      const node = findNode(tree, path);
      return {
        path,
        name: node?.name || path.split("/").pop() || path,
        category:
          node?.path && node.path.includes("/")
            ? node.path.split("/").slice(0, -1).join(" / ")
            : "Wardrobe",
      };
    });
  }, [wornOutfits, tree]);

  const isWorn = useCallback(
    (path) => wornOutfits.some((worn) => samePath(worn, path)),
    [wornOutfits]
  );

  const crumbs = useMemo(() => {
    const parts = selectedPath ? selectedPath.split("/") : [];
    return parts.map((part, index) => ({
      name: part,
      path: parts.slice(0, index + 1).join("/"),
    }));
  }, [selectedPath]);

  function getImage(outfit) {
    return (
      images.find((image) => image.id === outfit.id) ||
      images.find(
        (image) => image.imageName?.trim().toLowerCase() === outfit.name.trim().toLowerCase()
      )
    );
  }

  function pickImageFile(outfit, file) {
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/webp"];
    if (!allowed.includes(file.type)) {
      setNotice("Please choose a JPEG, PNG, or WebP image.");
      return;
    }
    setPendingUpload({ outfit, file });
  }

  async function saveImage(imageName) {
    if (!pendingUpload) return;
    const { outfit, file } = pendingUpload;
    setPendingUpload(null);
    try {
      const compressed = await compressImage(file);
      await putImage({
        id: outfit.id,
        outfitPath: outfit.path,
        outfitName: outfit.name,
        imageName,
        mimeType: compressed.type,
        blob: compressed,
        updatedAt: Date.now(),
      });
      await reloadImages();
      setNotice(
        `Saved the preview image for ${outfit.name} (${Math.round(compressed.size / 1024)} KB).`
      );
    } catch (err) {
      console.error(err);
      setNotice("Could not save the image to local browser storage.");
    }
  }

  function removePreview(outfit) {
    setConfirmState({
      title: "Remove preview image?",
      message: `The preview image for "${outfit.name}" will be removed from this browser.`,
      confirmLabel: "Remove",
      onConfirm: async () => {
        setConfirmState(null);
        try {
          await deleteImage(outfit.id);
          await reloadImages();
          setNotice("Preview image removed.");
        } catch (err) {
          console.error(err);
          setNotice("Could not remove that preview image.");
        }
      },
    });
  }

  async function exportImageLibrary() {
    try {
      const records = await getAllImages();
      const files = {};
      const manifestImages = [];

      for (let i = 0; i < records.length; i += 1) {
        const record = records[i];
        if (!record.blob) continue;
        const ext = record.blob.type === "image/webp" ? "webp" : "jpg";
        const fileName = `images/${String(i + 1).padStart(4, "0")}.${ext}`;
        // JPEGs are already compressed, so store them without re-deflating.
        files[fileName] = [new Uint8Array(await record.blob.arrayBuffer()), { level: 0 }];
        manifestImages.push({
          id: record.id,
          outfitPath: record.outfitPath || record.id,
          outfitName: record.outfitName || "",
          imageName: record.imageName || "",
          mimeType: record.blob.type || record.mimeType || "image/jpeg",
          updatedAt: record.updatedAt || Date.now(),
          file: fileName,
        });
      }

      files["manifest.json"] = [
        strToU8(
          JSON.stringify(
            {
              format: "closety-image-library",
              version: 2,
              exportedAt: new Date().toISOString(),
              images: manifestImages,
            },
            null,
            2
          )
        ),
        { level: 6 },
      ];

      const zipped = zipSync(files);
      downloadBlob(new Blob([zipped], { type: "application/zip" }), "closety-images.zip");
      setNotice(`Exported ${manifestImages.length} image(s) as ZIP.`);
    } catch (err) {
      console.error(err);
      setNotice("Image library export failed.");
    }
  }

  async function importImageLibrary(file) {
    if (!file) return;
    try {
      let count = 0;

      if (/\.json$/i.test(file.name)) {
        // Old JSON backups (base64). Still accepted, and compressed on the way in.
        const data = JSON.parse(await file.text());
        if (data.format !== "closety-image-library" || !Array.isArray(data.images)) {
          throw new Error("That file is not a Closety image-library backup.");
        }
        for (const record of data.images) {
          if (!record || typeof record.id !== "string") continue;
          const compressed = await compressImage(base64ToBlob(record.base64, record.mimeType));
          await putImage({
            id: record.id,
            outfitPath: record.outfitPath || record.id,
            outfitName: record.outfitName || "",
            imageName: record.imageName || record.outfitName || "",
            mimeType: compressed.type,
            updatedAt: record.updatedAt || Date.now(),
            blob: compressed,
          });
          count += 1;
        }
      } else {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        if (!entries["manifest.json"]) {
          throw new Error("That ZIP is not a Closety image-library backup.");
        }
        const manifest = JSON.parse(strFromU8(entries["manifest.json"]));
        if (manifest.format !== "closety-image-library" || !Array.isArray(manifest.images)) {
          throw new Error("That ZIP is not a Closety image-library backup.");
        }
        for (const record of manifest.images) {
          const bytes = entries[record?.file];
          if (!record || typeof record.id !== "string" || !bytes) continue;
          await putImage({
            id: record.id,
            outfitPath: record.outfitPath || record.id,
            outfitName: record.outfitName || "",
            imageName: record.imageName || record.outfitName || "",
            mimeType: record.mimeType || "image/jpeg",
            updatedAt: record.updatedAt || Date.now(),
            blob: new Blob([bytes], { type: record.mimeType || "image/jpeg" }),
          });
          count += 1;
        }
      }

      await reloadImages();
      setNotice(`Imported ${count} image(s).`);
    } catch (err) {
      console.error(err);
      setNotice(`Import failed: ${err.message || "Invalid backup file."}`);
    }
  }

  /* The core of the fix.
     Optimistically flips the local worn list on click, then sends the
     command to the HUD. Rolls back on failure.
     ZERO calls to ?action=status after the POST returns. */
  async function postCommand(action, outfit) {
    const key = outfit?.id || outfit?.path;
    const wasAlreadyWorn = outfit?.path ? isWorn(outfit.path) : false;

    // ---- Optimistic local update (no server round-trip) ----
    if (action === "wear" && outfit?.path) {
      setWornOutfits((prev) =>
        prev.some((p) => samePath(p, outfit.path))
          ? prev
          : [...prev, outfit.path]
      );
    } else if (action === "remove" && outfit?.path) {
      setWornOutfits((prev) => prev.filter((p) => !samePath(p, outfit.path)));
    } else if (action === "strip_all") {
      setWornOutfits([]);
    }

    setBusyCommand(outfit ? `${action}:${key}` : action);
    setNotice("");

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "enqueue_command",
          token,
          command: {
            action,
            path: outfit?.path || "",
            outfitName: outfit?.name || "",
            requestedAt: new Date().toISOString(),
          },
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(data.error || "The command could not be queued.");
      }

      setNotice(
        `${action.replaceAll("_", " ").toUpperCase()} queued. Keep the Closety HUD attached in Second Life.`
      );

      // No follow-up fetch. The next status poll happens only when
      // the user clicks Refresh.
    } catch (err) {
      console.error(err);
      setNotice(`Command not sent: ${err.message}.`);
      // Roll back the optimistic update.
      if (action === "wear" && outfit?.path && !wasAlreadyWorn) {
        setWornOutfits((prev) => prev.filter((p) => !samePath(p, outfit.path)));
      } else if (action === "remove" && outfit?.path && wasAlreadyWorn) {
        setWornOutfits((prev) =>
          prev.some((p) => samePath(p, outfit.path)) ? prev : [...prev, outfit.path]
        );
      }
      // strip_all rollback not attempted (requires a fetch to know
      // what was previously worn). User can click Refresh if needed.
    } finally {
      setBusyCommand("");
    }
  }

  function sendCommand(action, outfit = null) {
    if (!token) {
      setNotice("Open the paired HUD link before sending wardrobe commands.");
      return;
    }

    if (action === "strip_all") {
      setConfirmState({
        title: "Strip all?",
        message:
          "This removes all items managed by Closety inside #RLV/WC. Items outside that folder should not be affected.",
        confirmLabel: "Strip all",
        onConfirm: () => {
          setConfirmState(null);
          postCommand(action, null);
        },
      });
      return;
    }

    postCommand(action, outfit);
  }

  function jumpToOutfitInCloset(path) {
    setActiveTab("closet");
    setSearch("");
    setSelectedPath(parentPathOf(path));
    window.setTimeout(() => {
      const el = document.querySelector(`[data-outfit-id="${CSS.escape(path)}"]`);
      if (el && typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("outfit-flash");
        window.setTimeout(() => el.classList.remove("outfit-flash"), 1600);
      }
    }, 60);
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
      ? scanStatus === "complete" ? "online" : "pending"
      : "offline";

  const browseTitle = selectedNode?.path ? `${selectedNode.name} folders` : "Browse your folders";

  return (
    <div className={`app-shell theme-${theme}`} id="top">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Closety home">
          <span className="brand-logo"><span className="brand-dress">♙</span></span>
          <span className="brand-copy">
            <strong>closety<span>.</span></strong>
            <small>YOUR VIRTUAL WARDROBE</small>
          </span>
        </a>

        <div className="sidebar-label">YOUR SPACE</div>

        <div className="sidebar-tabs">
          <button
            type="button"
            className={`nav-link ${activeTab === "closet" ? "active" : ""}`}
            onClick={() => setActiveTab("closet")}
          >
            <span className="nav-icon">▦</span>
            <span>My Closet</span>
          </button>

          <button
            type="button"
            className={`nav-link ${activeTab === "wearing" ? "active" : ""}`}
            onClick={() => setActiveTab("wearing")}
          >
            <span className="nav-icon">◉</span>
            <span>Currently Wearing</span>
            {wornNow.length > 0 && <span className="nav-count">{wornNow.length}</span>}
          </button>
        </div>

        {activeTab === "closet" && (
          <div className="sidebar-tree-container">
            {folders.length ? (
              <div className="sidebar-tree">
                <FolderTree
                  node={tree}
                  selectedPath={selectedPath}
                  onSelect={setSelectedPath}
                  defaultExpanded
                />
              </div>
            ) : (
              <div className="sidebar-tree-empty">
                <span>📂</span>
                <strong>No folders yet</strong>
                <p>Scan your wardrobe with the HUD.</p>
              </div>
            )}
          </div>
        )}

        <div className="sidebar-bottom">
          <div className="avatar-badge">SL</div>
          <div className="sidebar-avatar-text">
            <strong>Second Life</strong>
            <small>{avatarName || "HUD connection"}</small>
          </div>
          <span className={`tiny-status ${connection === "connected" ? "green" : ""}`} />
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            {activeTab === "closet"
              ? <>My Closet <span>/</span> Overview</>
              : <>My Closet <span>/</span> Currently Wearing</>}
          </div>
          <div className="topbar-actions">
            <span className="privacy-badge"><span>⌑</span> PRIVATE WARDROBE</span>
            <button
              className="theme-toggle"
              type="button"
              onClick={() => setTheme((v) => (v === "light" ? "dark" : "light"))}
              aria-label={`Switch to ${theme === "light" ? "night" : "day"} theme`}
              title="Toggle day/night mode"
            >
              {theme === "light" ? "☾" : "☀"}
            </button>
          </div>
        </header>

        <div className="page-content">
          <section className="hero">
            <div className="hero-copy">
              <div className="eyebrow">
                <span className="eyebrow-line" />
                YOUR SPACE. YOUR STYLE.
              </div>
              <h1>Your closet,<br /><span>your way.</span></h1>
              <p>
                One organised home for your Second Life wardrobe.
                <br className="hero-break" />
                Find your favourite looks, all in one place.
              </p>
              <a className="hero-link" href="#outfits">
                Explore my closet <span>↗</span>
              </a>
            </div>

            <div className="hero-art" aria-hidden="true">
              <div className="hero-orbit orbit-one" />
              <div className="hero-orbit orbit-two" />
              <div className="hero-halo" />
              <div className="hero-card hero-card-back"><span>✳</span></div>
              <div className="hero-card hero-card-front">
                <div className="hero-card-top"><span>closety</span><span>♡</span></div>
                <div className="hero-dress">♙</div>
                <div className="hero-card-lines"><i /><i /></div>
                <div className="hero-card-bottom">YOUR NEXT LOOK</div>
              </div>
              <span className="hero-float float-one">✦</span>
              <span className="hero-float float-two">✳</span>
              <span className="hero-float float-three">♡</span>
              <div className="hero-caption">
                <span className="caption-dot" />
                A little space for your style
              </div>
            </div>

            <div className="hero-decoration" aria-hidden="true">✳</div>
          </section>

          <section className="connection-panel">
            <div className="connection-symbol"><span>⌘</span><i /></div>
            <div className="connection-copy">
              <small>SECOND LIFE INTEGRATION</small>
              <h2>Closety HUD</h2>
              <p>
                {avatarName
                  ? `Paired with ${avatarName}`
                  : "Your in-world wardrobe, connected to your closet."}
              </p>
            </div>

            <div className="connection-controls">
              <span className={`status-pill ${statusClass}`}><i /> {statusText}</span>
              <button
                className="button primary refresh-button"
                type="button"
                onClick={refreshWardrobe}
                disabled={refreshing}
              >
                <span className={refreshing ? "spin" : ""}>↻</span>
                {refreshing ? "Refreshing…" : "Refresh"}
              </button>
            </div>
          </section>

          {error && (
            <div className="alert error-alert">
              <span className="alert-symbol">!</span>
              <span>{error}</span>
              <button type="button" onClick={() => setError("")} aria-label="Dismiss error">×</button>
            </div>
          )}

          {notice && (
            <div className="notice-popup">
              <span className="alert-symbol">✓</span>
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice("")} aria-label="Dismiss notice">×</button>
            </div>
          )}

          {activeTab === "closet" && (
            <section className="stats-grid">
              <article className="stat-card">
                <span className="stat-icon stat-green">▤</span>
                <div className="stat-copy">
                  <small>OUTFIT CANDIDATES</small>
                  <strong>{allOutfits.length}</strong>
                  <p>Looks in your collection</p>
                </div>
                <span className="stat-watermark">✳</span>
              </article>

              <article className="stat-card">
                <span className="stat-icon stat-purple">▧</span>
                <div className="stat-copy">
                  <small>PREVIEW IMAGES</small>
                  <strong>{images.length}</strong>
                  <p>Saved in this browser</p>
                </div>
                <span className="stat-watermark">♡</span>
              </article>

              <article className="stat-card">
                <span className="stat-icon stat-peach">◷</span>
                <div className="stat-copy">
                  <small>LAST REFRESH</small>
                  <strong className="last-refresh">
                    {lastUpdated
                      ? lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                      : "—"}
                  </strong>
                  <p>Latest wardrobe sync</p>
                </div>
                <span className="stat-watermark">⌁</span>
              </article>
            </section>
          )}

          {activeTab === "closet" && (
            <section className="section-block" id="outfits">
              <div className="section-header">
                <div>
                  <div className="eyebrow">YOUR COLLECTION</div>
                  <h2>My closet <span className="heading-sparkle">✳</span></h2>
                  <p>All your favourite looks, gathered in one place.</p>
                </div>

                <div className="backup-actions">
                  <button className="button secondary" type="button" onClick={exportImageLibrary}>
                    <span>↓</span> Export ZIP
                  </button>

                  <label className="button secondary file-button">
                    <span>↑</span> Import ZIP
                    <input
                      type="file"
                      accept=".zip,application/zip,.json,application/json"
                      onChange={(event) => {
                        importImageLibrary(event.target.files?.[0]);
                        event.target.value = "";
                      }}
                    />
                  </label>
                </div>
              </div>

              <div className="closet-layout">
                <div className="closet-content">
                  <nav className="folder-pagination" aria-label="Folder path">
                    <button
                      type="button"
                      className={`crumb ${!selectedPath ? "current" : ""}`}
                      onClick={() => setSelectedPath("")}
                      disabled={!selectedPath}
                    >
                      My Closet
                    </button>

                    {crumbs.map((crumb, index) => {
                      const last = index === crumbs.length - 1;
                      return (
                        <span className="crumb-group" key={crumb.path}>
                          <span className="crumb-sep">›</span>
                          <button
                            type="button"
                            className={`crumb ${last ? "current" : ""}`}
                            onClick={() => setSelectedPath(crumb.path)}
                            disabled={last}
                          >
                            {crumb.name}
                          </button>
                        </span>
                      );
                    })}
                  </nav>

                  <div className="outfit-toolbar">
                    <label className="search-field">
                      <span className="search-icon">⌕</span>
                      <input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Search outfits and categories..."
                        aria-label="Search outfits and categories"
                      />
                      {search && (
                        <button type="button" onClick={() => setSearch("")} aria-label="Clear search">×</button>
                      )}
                    </label>

                    <div className="toolbar-right">
                      <span className="result-count">{visibleOutfits.length} looks</span>
                    </div>
                  </div>

                  {!isSearching && folderCards.length > 0 && (
                    <div className="browse-folders">
                      <div className="browse-heading">
                        <div>
                          <small>FOLDER COLLECTION</small>
                          <h3>{browseTitle}</h3>
                        </div>
                        <span>{folderCards.length} folders</span>
                      </div>

                      <div className="folder-card-grid">
                        {folderCards.map((folder, index) => (
                          <button
                            className={`folder-card folder-card-${index % 3}`}
                            key={folder.path}
                            type="button"
                            onClick={() => setSelectedPath(folder.path)}
                          >
                            <span className="folder-card-icon">📁</span>
                            <span className="folder-card-copy">
                              <strong>{folder.name}</strong>
                              <small>
                                {countItemsAndFolders(folder)}{" "}
                                {countItemsAndFolders(folder) === 1 ? "item" : "items"}
                              </small>
                            </span>
                            <span className="folder-card-arrow">↗</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="outfit-scroll-area">
                    <div className="outfit-grid">
                      {visibleOutfits.map((outfit) => (
                        <div key={outfit.id} data-outfit-id={outfit.id}>
                          <OutfitCard
                            outfit={outfit}
                            image={getImage(outfit)}
                            busyCommand={busyCommand}
                            isWorn={isWorn(outfit.path)}
                            onPickFile={pickImageFile}
                            onRemoveImage={removePreview}
                            onCommand={sendCommand}
                          />
                        </div>
                      ))}
                    </div>

                    {!visibleOutfits.length && !folderCards.length && (
                      <div className="empty-state">
                        <span className="empty-icon">{folders.length ? "⌕" : "✳"}</span>
                        <h3>{folders.length ? "No matching outfits" : "Your closet is waiting"}</h3>
                        <p>
                          {folders.length
                            ? "Try another search or choose a different folder."
                            : "Scan your #RLV/WC folder with your in-world HUD, then click Refresh."}
                        </p>
                        {selectedPath && (
                          <button className="button secondary" type="button" onClick={() => setSelectedPath("")}>
                            Back to closet
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <p className="inventory-note">
                The number next to a folder is the number of subfolders and items directly inside it.
              </p>
            </section>
          )}

          {activeTab === "wearing" && (
            <section className="section-block" id="wearing">
              <div className="section-header">
                <div>
                  <div className="eyebrow">LIVE FROM #RLV/WC</div>
                  <h2>Currently wearing <span className="heading-sparkle">◉</span></h2>
                  <p>
                    {wornNow.length
                      ? `${wornNow.length} outfit${wornNow.length === 1 ? "" : "s"} on your avatar right now.`
                      : "Nothing from your wardrobe is worn right now."}
                  </p>
                </div>

                <span className={`wearing-count ${wornNow.length ? "live" : ""}`}>
                  {wornNow.length ? "🟢 LIVE" : "⚪ IDLE"}
                </span>
              </div>

              {wornNow.length > 0 ? (
                <div className="outfit-grid">
                  {wornNow.map((item) => (
                    <WornCard
                      key={item.path}
                      item={item}
                      image={getImage({ id: item.path, name: item.name })}
                      busyCommand={busyCommand}
                      onJumpToCloset={jumpToOutfitInCloset}
                      onCommand={sendCommand}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon">◉</span>
                  <h3>Nothing worn</h3>
                  <p>
                    Wear something from your closet, then click Refresh to see it here.
                  </p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => setActiveTab("closet")}
                  >
                    Browse my closet
                  </button>
                </div>
              )}
            </section>
          )}

          {activeTab === "closet" && (
            <div className="strip-panel">
              <div className="strip-copy">
                <span className="strip-icon">✳</span>
                <div>
                  <h3>Ready for a fresh start?</h3>
                  <p>Remove the items managed by Closety inside <code>#RLV/WC</code>.</p>
                </div>
              </div>

              <button
                className="button strip-button"
                type="button"
                disabled={Boolean(busyCommand)}
                onClick={() => sendCommand("strip_all")}
              >
                {busyCommand === "strip_all" ? "SENDING…" : "Strip all"}
                <span>↗</span>
              </button>
            </div>
          )}

          <footer className="page-footer">
            <span>
              closety<span className="footer-heart"> ♥ </span>made for your Second Life wardrobe
            </span>
            <span>LOCAL IMAGE LIBRARY · #RLV/WC</span>
          </footer>
        </div>
      </main>

      {pendingUpload && (
        <ImageNameModal
          outfit={pendingUpload.outfit}
          file={pendingUpload.file}
          onSave={saveImage}
          onCancel={() => setPendingUpload(null)}
        />
      )}

      {confirmState && (
        <ConfirmModal
          title={confirmState.title}
          message={confirmState.message}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  );
}