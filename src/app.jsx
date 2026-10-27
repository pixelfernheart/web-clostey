
import { useEffect, useMemo, useState } from "react";
import "./style.css";

const API_URL = "/api/hud-sync";

function buildTree(paths) {
  const root = { name: "WC", children: {} };

  for (const originalPath of paths || []) {
    const parts = String(originalPath)
      .replace(/^#?RLV[\\/]/i, "")
      .replace(/^WC[\\/]/i, "")
      .split(/[\\/]/)
      .filter(Boolean);

    let node = root;

    for (const part of parts) {
      if (!node.children[part]) {
        node.children[part] = { name: part, children: {} };
      }
      node = node.children[part];
    }
  }

  return root;
}

function Folder({ node, depth = 0 }) {
  const [open, setOpen] = useState(depth < 1);
  const children = Object.values(node.children || {}).sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <div className="folder-node">
      <button
        className="folder-row"
        style={{ paddingLeft: `${14 + depth * 20}px` }}
        onClick={() => setOpen(!open)}
        type="button"
      >
        <span className="folder-chevron">
          {children.length ? (open ? "⌄" : "›") : "·"}
        </span>
        <span className="folder-icon">{children.length ? "📁" : "🗂️"}</span>
        <span className="folder-name">{node.name}</span>
        {children.length > 0 && (
          <span className="folder-count">{children.length}</span>
        )}
      </button>

      {open &&
        children.map((child) => (
          <Folder key={child.name} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export default function App() {
  const token = useMemo(
    () => new URLSearchParams(window.location.search).get("token"),
    []
  );

  const [connection, setConnection] = useState("checking");
  const [avatarName, setAvatarName] = useState("");
  const [avatarUUID, setAvatarUUID] = useState("");
  const [scanStatus, setScanStatus] = useState("waiting");
  const [folders, setFolders] = useState([]);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setConnection("disconnected");
      return;
    }

    let active = true;
    let timer;

    async function refresh() {
      try {
        const response = await fetch(
          `${API_URL}?action=state&token=${encodeURIComponent(token)}`,
          { cache: "no-store" }
        );

        const data = await response.json();

        if (!active) return;

        if (!response.ok || !data.connected) {
          setConnection("disconnected");
          setError(data.error || "The HUD connection could not be verified.");
          return;
        }

        setConnection("connected");
        setError("");
        setAvatarName(data.avatarName || "Second Life avatar");
        setAvatarUUID(data.avatarUUID || "");
        setScanStatus(data.scanStatus || "waiting");
        setFolders(Array.isArray(data.folders) ? data.folders : []);
        setLastUpdated(data.updatedAt ? new Date(data.updatedAt) : null);
      } catch {
        if (!active) return;
        setConnection("error");
        setError("Cannot reach the Closety server. Check your internet connection.");
      }
    }

    refresh();
    timer = window.setInterval(refresh, 4000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [token]);

  const tree = useMemo(() => buildTree(folders), [folders]);

  const status = !token
    ? "HUD NOT CONNECTED"
    : connection === "checking"
      ? "CHECKING CONNECTION"
      : connection === "error"
        ? "CONNECTION ERROR"
        : connection === "disconnected"
          ? "HUD NOT CONNECTED"
          : scanStatus === "complete"
            ? "HUD CONNECTED"
            : scanStatus === "scanning"
              ? "SCANNING WARDROBE"
              : "HUD PAIRED · WAITING FOR SCAN";

  const statusClass =
    connection === "connected"
      ? scanStatus === "complete"
        ? "status-connected"
        : "status-pending"
      : "status-offline";

  return (
    <main className="closety-app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div>
            <div className="brand-name">closety</div>
            <div className="brand-subtitle">YOUR VIRTUAL WARDROBE</div>
          </div>
        </div>

        <div className="side-label">WARDROBE</div>
        <div className="side-link active">
          <span>▦</span> My Closet
        </div>
        <div className="side-link muted">
          <span>◇</span> Outfits
          <span className="coming-soon">SYNC</span>
        </div>
        <div className="side-link muted">
          <span>▧</span> Categories
        </div>

        <div className="sidebar-bottom">
          <div className="mini-avatar">SL</div>
          <div className="sidebar-user">
            <strong>Second Life</strong>
            <span>HUD connection</span>
          </div>
          <span className="small-dot" />
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <div className="breadcrumb">My Closet <span>/</span> Overview</div>
          <div className="topbar-right">
            <span className="private-tag">🔒 PRIVATE CLOSET</span>
            <div className="top-avatar">C</div>
          </div>
        </header>

        <div className="content">
          <div className="welcome-row">
            <div>
              <div className="eyebrow">YOUR SPACE. YOUR STYLE.</div>
              <h1>Your closet, <span>your way.</span></h1>
              <p className="welcome-copy">
                Keep your Second Life wardrobe organised in one place.
              </p>
            </div>
            <div className="decorative-orbit">
              <div className="orbit-circle">✳</div>
              <span className="orbit-dot dot-one" />
              <span className="orbit-dot dot-two" />
            </div>
          </div>

          <section className="connection-card">
            <div className="connection-left">
              <div className="connection-icon">⌘</div>
              <div>
                <div className="card-overline">SECOND LIFE INTEGRATION</div>
                <h2>Closety HUD</h2>
                <p>
                  {avatarName
                    ? `Paired avatar: ${avatarName}`
                    : "Connect your in-world HUD to sync your wardrobe."}
                </p>
                {avatarUUID && (
                  <div className="avatar-uuid">Avatar UUID: {avatarUUID}</div>
                )}
              </div>
            </div>
            <div className="connection-right">
              <div className={`status-pill ${statusClass}`}>
                <span className="status-dot" />
                {status}
              </div>
              <p className="connection-hint">
                {scanStatus === "complete" && connection === "connected"
                  ? "Your latest scan is available below."
                  : "Use CONNECT and then SCAN in your in-world HUD."}
              </p>
            </div>
          </section>

          {error && (
            <div className="error-message">
              <strong>Connection issue</strong>
              <span>{error}</span>
              {!token && (
                <span>
                  Open the website using the URL supplied by your Closety HUD.
                </span>
              )}
            </div>
          )}

          <div className="stats-grid">
            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-label">DISCOVERED FOLDERS</span>
                <span className="stat-icon green-icon">▤</span>
              </div>
              <div className="stat-number">{folders.length}</div>
              <div className="stat-foot">Folders received from your HUD</div>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-label">HUD STATUS</span>
                <span className="stat-icon purple-icon">⌁</span>
              </div>
              <div className="stat-number stat-word">
                {connection === "connected" ? "Paired" : "Offline"}
              </div>
              <div className="stat-foot">
                {connection === "connected"
                  ? "Server recognises this pairing"
                  : "Waiting for a valid pairing"}
              </div>
            </article>

            <article className="stat-card">
              <div className="stat-top">
                <span className="stat-label">LAST UPDATE</span>
                <span className="stat-icon green-icon">◷</span>
              </div>
              <div className="stat-number stat-word">
                {lastUpdated
                  ? lastUpdated.toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "—"}
              </div>
              <div className="stat-foot">
                {lastUpdated ? lastUpdated.toLocaleDateString() : "No data yet"}
              </div>
            </article>
          </div>

          <section className="wardrobe-section">
            <div className="section-heading">
              <div>
                <div className="eyebrow">INVENTORY OVERVIEW</div>
                <h2>Your wardrobe folders</h2>
                <p>Folder structure received from your Second Life HUD.</p>
              </div>
              <span className="folder-total">{folders.length} folders</span>
            </div>

            {folders.length > 0 ? (
              <div className="folder-panel">
                <Folder node={tree} />
              </div>
            ) : (
              <div className="empty-state">
                <div className="empty-illustration">📂</div>
                <h3>Your closet is waiting</h3>
                <p>
                  Open Second Life, click CONNECT in your Closety HUD, then
                  choose SCAN to send your folder list here.
                </p>
                <div className="empty-steps">
                  <span><b>1</b> Wear the HUD</span>
                  <span><b>2</b> Click CONNECT</span>
                  <span><b>3</b> Click SCAN</span>
                </div>
              </div>
            )}

            <p className="inventory-note">
              <strong>Note:</strong> RLV folder discovery returns folder names
              and paths, not a complete list of loose wearable objects inside
              every folder. Outfit item details need additional HUD support.
            </p>
          </section>

          <footer className="footer">
            <span>closety <span className="footer-heart">♥</span> made for your Second Life wardrobe</span>
            <span>PRIVATE WARDROBE</span>
          </footer>
        </div>
      </section>
    </main>
  );
}
