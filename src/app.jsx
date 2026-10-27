
import { useEffect, useState } from "react";
import {
  getProfiles,
  getWardrobe,
  exportBackup,
  importBackup,
  requestPersistentStorage,
  getStorageEstimate,
} from "./db";

import "./style.css";

export default function App() {
  const [profiles, setProfiles] = useState([]);
  const [activeId, setActiveId] = useState("");
  const [root, setRoot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState({});
  const [storage, setStorage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    initialize();
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadWardrobe() {
      if (!activeId) {
        setRoot(null);
        return;
      }

      try {
        const wardrobe = await getWardrobe(activeId);

        if (!cancelled) {
          setRoot(wardrobe || null);
        }
      } catch (error) {
        if (!cancelled) {
          setNotice(`Could not load wardrobe: ${error.message}`);
          setRoot(null);
        }
      }
    }

    loadWardrobe();

    return () => {
      cancelled = true;
    };
  }, [activeId]);

  async function initialize() {
    try {
      await requestPersistentStorage();

      const savedProfiles = await getProfiles();

      setProfiles(savedProfiles);

      if (savedProfiles.length > 0) {
        setActiveId(savedProfiles[0].id);
      }

      const estimate = await getStorageEstimate();
      setStorage(estimate);
    } catch (error) {
      setNotice(`Storage error: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function refreshProfiles(selectId) {
    const savedProfiles = await getProfiles();

    setProfiles(savedProfiles);

    if (selectId) {
      setActiveId(selectId);
    }

    const estimate = await getStorageEstimate();
    setStorage(estimate);
  }

  async function handleImport(event) {
    const file = event.target.files?.[0];

    // Allow the same backup file to be selected again.
    event.target.value = "";

    if (!file) return;

    setBusy(true);
    setNotice("");

    try {
      const profile = await importBackup(file);

      await refreshProfiles(profile.id);

      setNotice(
        `Backup restored successfully: "${profile.name}".`
      );
    } catch (error) {
      setNotice(`Import failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleExport() {
    if (!activeId || busy) return;

    setBusy(true);
    setNotice("");

    try {
      await exportBackup(activeId);
      setNotice("Backup export started.");
    } catch (error) {
      setNotice(`Export failed: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function toggleFolder(key) {
    setExpanded((previous) => ({
      ...previous,
      [key]: !previous[key],
    }));
  }

  function getItemName(item) {
    return item?.name || item?.label || "Unnamed item";
  }

  function nodeMatchesSearch(node, query) {
    if (!node) return false;

    const name = getItemName(node).toLowerCase();
    const path = (node.path || "").toLowerCase();

    if (name.includes(query) || path.includes(query)) {
      return true;
    }

    return Array.isArray(node.children) &&
      node.children.some((child) =>
        nodeMatchesSearch(child, query)
      );
  }

  function renderNode(node, path = "", depth = 0) {
    if (!node) return null;

    const name = getItemName(node);
    const nodePath = path ? `${path}/${name}` : name;

    const children = Array.isArray(node.children)
      ? node.children
      : [];

    const isFolder =
      node.type === "root" ||
      node.type === "folder" ||
      children.length > 0;

    if (isFolder) {
      const query = search.trim().toLowerCase();

      const visibleChildren = children.filter((child) =>
        !query || nodeMatchesSearch(child, query)
      );

      const isOpen =
        Boolean(query) || Boolean(expanded[nodePath]);

      return (
        <div
          className="inventory-folder"
          key={nodePath}
          style={{ "--depth": depth }}
        >
          <button
            className="folder-row"
            onClick={() => toggleFolder(nodePath)}
            type="button"
          >
            <span className="folder-icon">
              {isOpen ? "📂" : "📁"}
            </span>

            <span className="folder-name">{name}</span>

            <span className="folder-count">
              {children.length}
            </span>

            <span className="folder-chevron">
              {isOpen ? "−" : "+"}
            </span>
          </button>

          {isOpen && (
            <div className="folder-children">
              {visibleChildren.length > 0 ? (
                visibleChildren.map((child) =>
                  renderNode(child, nodePath, depth + 1)
                )
              ) : (
                <p className="empty-folder">
                  {query
                    ? "No matching items."
                    : "This folder is empty. Inventory will appear after a successful HUD sync."}
                </p>
              )}
            </div>
          )}
        </div>
      );
    }

    if (!nodeMatchesSearch(node, search.trim().toLowerCase())) {
      return null;
    }

    return (
      <div
        className="inventory-item"
        key={node.id || nodePath}
      >
        <div className="item-symbol">◇</div>

        <div className="item-details">
          <strong>{name}</strong>

          <span>
            {node.kind || node.type || "Inventory item"}
          </span>
        </div>

        <span className="item-status">Saved</span>
      </div>
    );
  }

  const activeProfile = profiles.find(
    (profile) => profile.id === activeId
  );

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes)) return "Unknown";

    if (bytes < 1024) {
      return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return (
    <main className="closety-app">
      <header className="topbar">
        <a className="brand" href="#home">
          <span className="brand-mark">C</span>

          <span>
            <strong>Closety</strong>
            <small>YOUR SECOND LIFE WARDROBE</small>
          </span>
        </a>

        <div className="topbar-right">
          <span className="local-badge">
            <span className="status-dot" />
            LOCAL STORAGE
          </span>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-heading">YOUR SPACE</div>

          <button
            className="nav-item active"
            type="button"
          >
            <span>▦</span>
            My Wardrobe
          </button>

          <div className="sidebar-divider" />

          <div className="sidebar-heading">
            BACKUP &amp; RESTORE
          </div>

          <button
            className="secondary-button full-width"
            disabled={!activeId || busy}
            onClick={handleExport}
            type="button"
          >
            ↓ Export backup
          </button>

          <label
            className={`secondary-button full-width file-button ${
              busy ? "disabled" : ""
            }`}
          >
            ↑ Import backup

            <input
              type="file"
              accept=".json,application/json"
              onChange={handleImport}
              disabled={busy}
              hidden
            />
          </label>

          <p className="sidebar-hint">
            Save a backup to a USB drive to help protect your
            wardrobe when reinstalling Windows.
          </p>

          <div className="sidebar-bottom">
            <div className="storage-heading">
              <span>Browser storage</span>
              <span>IndexedDB</span>
            </div>

            <p>Used: {formatBytes(storage?.usage)}</p>

            <p>
              Estimated limit: {formatBytes(storage?.quota)}
            </p>

            <small>
              Estimates cover this website's browser storage,
              not only Closety.
            </small>
          </div>
        </aside>

        <section className="main-content" id="home">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">
                YOUR PERSONAL COLLECTION
              </div>

              <h1>My Wardrobe</h1>

              <p className="subtitle">
                Your clothes, your folders, your space.
              </p>
            </div>

            <div className="sync-pill">
              <span className="status-dot muted-dot" />
              HUD NOT CONNECTED
            </div>
          </div>

          {notice && (
            <div className="notice" role="status">
              <span>{notice}</span>

              <button
                type="button"
                aria-label="Dismiss message"
                onClick={() => setNotice("")}
              >
                ×
              </button>
            </div>
          )}

          <section className="profile-banner">
            <div className="profile-avatar">SL</div>

            <div className="profile-info">
              <span>SECOND LIFE AVATAR</span>

              <h2>
                {activeProfile?.name ||
                  "Waiting for HUD connection"}
              </h2>

              <p>
                {activeProfile
                  ? "Inventory root: #RLV/WC"
                  : "Your avatar UUID and wardrobe will be supplied by the HUD when the connection is implemented."}
              </p>
            </div>

            <div className="private-label">
              <span>●</span>
              {activeProfile ? "Local wardrobe" : "Not connected"}
            </div>
          </section>

          <div className="inventory-toolbar">
            <div>
              <h2>Inventory folders</h2>

              <p>
                Your folder structure will appear here after
                the HUD sync feature is connected.
              </p>
            </div>

            <div className="search-box">
              <span>⌕</span>

              <input
                aria-label="Search inventory"
                placeholder="Search folders and items..."
                value={search}
                onChange={(event) =>
                  setSearch(event.target.value)
                }
              />
            </div>
          </div>

          <section className="inventory-panel">
            <div className="inventory-panel-header">
              <span>FOLDER STRUCTURE</span>
              <span>#RLV/WC</span>
            </div>

            {loading ? (
              <p className="empty-folder">
                Loading Closety...
              </p>
            ) : root ? (
              renderNode(root)
            ) : (
              <div className="empty-state">
                <div className="empty-icon">▤</div>

                <h2>Your wardrobe is waiting</h2>

                <p>
                  Once the HUD is built and connected, Closety
                  will receive your Second Life avatar details
                  and inventory data.
                </p>
              </div>
            )}
          </section>

          <section className="connection-card">
            <div className="connection-icon">↔</div>

            <div>
              <h3>Second Life connection</h3>

              <p>
                The website is not connected to Second Life yet.
                The next development stage is the RLV HUD and
                the secure process that sends inventory data
                to Closety.
              </p>
            </div>

            <span className="connection-status">
              Not connected
            </span>
          </section>

          <footer className="page-footer">
            <span>Closety · Private wardrobe workspace</span>
            <span>Local browser database</span>
          </footer>
        </section>
      </div>
    </main>
  );
}
