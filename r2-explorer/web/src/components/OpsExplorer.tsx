import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import {
  ApiError,
  createShare,
  deleteObject,
  fetchSessionInfo,
  listObjects,
  listShares,
  moveObject,
  multipartUpload,
  revokeShare,
  type ListResponse,
  type ObjectMetadata,
  type SessionInfoResponse,
  type ShareCreateResponse,
  type ShareRecord,
  type UploadProgress,
} from "../lib/api";

type ActivityItem = {
  id: number;
  timestamp: string;
  message: string;
  level: "info" | "success" | "error";
};

type UploadItem = {
  id: number;
  fileName: string;
  status: "queued" | "uploading" | "done" | "error";
  detail: string;
  uploadedParts: number;
  totalParts: number;
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "-";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 ** 2) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  if (value < 1024 ** 3) {
    return `${(value / 1024 ** 2).toFixed(2)} MiB`;
  }
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

function formatWhen(value: string | null): string {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function parentPrefix(prefix: string): string {
  if (!prefix) {
    return "";
  }
  const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const index = clean.lastIndexOf("/");
  if (index === -1) {
    return "";
  }
  return `${clean.slice(0, index + 1)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return `${error.message} (${error.code})`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isAuthRequired(error: unknown): error is ApiError {
  return (
    error instanceof ApiError &&
    error.status === 401 &&
    (error.code === "access_required" || error.code === "token_invalid")
  );
}

function readEtag(object: ObjectMetadata): string {
  return object.etag.replace(/^"|"$/g, "");
}

export function OpsExplorer(): JSX.Element {
  const [session, setSession] = useState<SessionInfoResponse | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [listComplete, setListComplete] = useState(true);
  const [folders, setFolders] = useState<string[]>([]);
  const [objects, setObjects] = useState<ObjectMetadata[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [shareCreateResult, setShareCreateResult] = useState<ShareCreateResponse | null>(null);
  const [shareTtl, setShareTtl] = useState("24h");
  const [shareMaxDownloads, setShareMaxDownloads] = useState("1");
  const [loadingList, setLoadingList] = useState(false);
  const [loadingShares, setLoadingShares] = useState(false);
  const [creatingShare, setCreatingShare] = useState(false);
  const [mutatingObject, setMutatingObject] = useState(false);
  const [fatalError, setFatalError] = useState<string>("");
  const [uploadItems, setUploadItems] = useState<UploadItem[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);

  const prefixInputRef = useRef<HTMLInputElement>(null);

  const selectedObject = useMemo(
    () => objects.find((object) => object.key === selectedKey) ?? null,
    [objects, selectedKey],
  );

  const selectedIndex = useMemo(() => {
    if (!selectedKey) {
      return -1;
    }
    return objects.findIndex((object) => object.key === selectedKey);
  }, [objects, selectedKey]);

  const appendActivity = useCallback((message: string, level: ActivityItem["level"] = "info") => {
    setActivity((current) => {
      const entry: ActivityItem = {
        id: Date.now() + Math.floor(Math.random() * 10_000),
        timestamp: new Date().toISOString(),
        message,
        level,
      };
      return [entry, ...current].slice(0, 150);
    });
  }, []);

  const setUploadProgress = useCallback((id: number, updater: (current: UploadItem) => UploadItem) => {
    setUploadItems((current) => current.map((item) => (item.id === id ? updater(item) : item)));
  }, []);

  const refreshList = useCallback(
    async (nextCursor?: string) => {
      setLoadingList(true);
      setFatalError("");
      try {
        const payload: ListResponse = await listObjects(prefix, nextCursor, 200);
        setAuthRequired(false);
        setFolders(payload.delimitedPrefixes);
        setObjects(payload.objects);
        setCursor(payload.cursor);
        setListComplete(payload.listComplete);

        if (!payload.objects.some((object) => object.key === selectedKey)) {
          setSelectedKey(payload.objects[0]?.key ?? null);
        }

        appendActivity(
          `Listed ${payload.objects.length} objects and ${payload.delimitedPrefixes.length} prefixes for "${prefix || "/"}".`,
          "success",
        );
      } catch (error) {
        if (isAuthRequired(error)) {
          setAuthRequired(true);
          setFatalError("Sign in required to access R2 Explorer.");
          appendActivity("Authentication required. Use Sign in to continue.", "error");
          return;
        }
        const message = errorMessage(error);
        setFatalError(message);
        appendActivity(`List failed: ${message}`, "error");
      } finally {
        setLoadingList(false);
      }
    },
    [appendActivity, prefix, selectedKey],
  );

  const loadShares = useCallback(
    async (objectKey: string) => {
      setLoadingShares(true);
      try {
        const payload = await listShares(objectKey);
        setAuthRequired(false);
        setShares(payload.shares);
      } catch (error) {
        if (isAuthRequired(error)) {
          setAuthRequired(true);
          setFatalError("Sign in required to manage shares.");
          return;
        }
        setShares([]);
        appendActivity(`Share listing failed: ${errorMessage(error)}`, "error");
      } finally {
        setLoadingShares(false);
      }
    },
    [appendActivity],
  );

  const reloadSelectedShares = useCallback(async () => {
    if (!selectedObject) {
      return;
    }
    await loadShares(selectedObject.key);
  }, [loadShares, selectedObject]);

  const startLogin = useCallback(() => {
    window.location.assign("/cdn-cgi/access/login");
  }, []);

  const openPreview = useCallback(
    (key: string) => {
      if (authRequired) {
        startLogin();
        return;
      }
      window.open(`/api/v2/preview?key=${encodeURIComponent(key)}`, "_blank", "noopener,noreferrer");
    },
    [authRequired, startLogin],
  );

  const openDownload = useCallback(
    (key: string) => {
      if (authRequired) {
        startLogin();
        return;
      }
      window.open(`/api/v2/download?key=${encodeURIComponent(key)}`, "_blank", "noopener,noreferrer");
    },
    [authRequired, startLogin],
  );

  const signOut = useCallback(() => {
    window.location.assign("/cdn-cgi/access/logout");
  }, []);

  const moveSelection = useCallback(
    (delta: number) => {
      if (objects.length === 0) {
        return;
      }
      const base = selectedIndex >= 0 ? selectedIndex : 0;
      const next = Math.min(objects.length - 1, Math.max(0, base + delta));
      setSelectedKey(objects[next].key);
    },
    [objects, selectedIndex],
  );

  const performObjectMove = useCallback(async () => {
    if (!selectedObject) {
      return;
    }
    const target = window.prompt("Move object to key", selectedObject.key);
    if (!target || target === selectedObject.key) {
      return;
    }
    setMutatingObject(true);
    try {
      await moveObject(selectedObject.key, target);
      appendActivity(`Moved ${selectedObject.key} -> ${target}`, "success");
      setSelectedKey(target);
      await refreshList();
    } catch (error) {
      appendActivity(`Move failed: ${errorMessage(error)}`, "error");
    } finally {
      setMutatingObject(false);
    }
  }, [appendActivity, refreshList, selectedObject]);

  const performObjectDelete = useCallback(async () => {
    if (!selectedObject) {
      return;
    }
    const confirmed = window.confirm(`Delete ${selectedObject.key}? The object will move into .trash/.`);
    if (!confirmed) {
      return;
    }
    setMutatingObject(true);
    try {
      await deleteObject(selectedObject.key);
      appendActivity(`Moved ${selectedObject.key} to trash`, "success");
      setSelectedKey(null);
      await refreshList();
    } catch (error) {
      appendActivity(`Delete failed: ${errorMessage(error)}`, "error");
    } finally {
      setMutatingObject(false);
    }
  }, [appendActivity, refreshList, selectedObject]);

  const performShareCreate = useCallback(async () => {
    if (!selectedObject) {
      return;
    }
    const parsedMaxDownloads = Number.parseInt(shareMaxDownloads, 10);
    const maxDownloads = Number.isFinite(parsedMaxDownloads) && parsedMaxDownloads >= 0 ? parsedMaxDownloads : 1;

    setCreatingShare(true);
    try {
      const created = await createShare(selectedObject.key, shareTtl, maxDownloads);
      setShareCreateResult(created);
      appendActivity(`Created share token ${created.tokenId} for ${selectedObject.key}`, "success");
      await loadShares(selectedObject.key);
    } catch (error) {
      appendActivity(`Share create failed: ${errorMessage(error)}`, "error");
    } finally {
      setCreatingShare(false);
    }
  }, [appendActivity, loadShares, selectedObject, shareMaxDownloads, shareTtl]);

  const performShareRevoke = useCallback(
    async (tokenId: string) => {
      try {
        await revokeShare(tokenId);
        appendActivity(`Revoked share ${tokenId}`, "success");
        await reloadSelectedShares();
      } catch (error) {
        appendActivity(`Share revoke failed: ${errorMessage(error)}`, "error");
      }
    },
    [appendActivity, reloadSelectedShares],
  );

  const enqueueUpload = useCallback(
    async (file: File) => {
      const id = Date.now() + Math.floor(Math.random() * 1024);
      setUploadItems((current) => [
        {
          id,
          fileName: file.name,
          status: "queued",
          detail: "Waiting",
          uploadedParts: 0,
          totalParts: 0,
        },
        ...current,
      ]);

      try {
        setUploadProgress(id, (item) => ({ ...item, status: "uploading", detail: "Initializing upload" }));
        const completed = await multipartUpload(file, prefix, (progress: UploadProgress) => {
          setUploadProgress(id, (item) => ({
            ...item,
            status: "uploading",
            detail: `Phase: ${progress.phase}`,
            uploadedParts: progress.uploadedParts,
            totalParts: progress.totalParts,
          }));
        });
        setUploadProgress(id, (item) => ({
          ...item,
          status: "done",
          detail: `Stored as ${completed.key}`,
          uploadedParts: Math.max(item.uploadedParts, item.totalParts),
        }));
        appendActivity(`Uploaded ${file.name} to ${completed.key}`, "success");
        await refreshList();
      } catch (error) {
        const message = errorMessage(error);
        setUploadProgress(id, (item) => ({
          ...item,
          status: "error",
          detail: message,
        }));
        appendActivity(`Upload failed for ${file.name}: ${message}`, "error");
      }
    },
    [appendActivity, prefix, refreshList, setUploadProgress],
  );

  useEffect(() => {
    const bootstrap = async (): Promise<void> => {
      let sessionLoaded = false;
      try {
        const payload = await fetchSessionInfo();
        setSession(payload);
        setAuthRequired(false);
        sessionLoaded = true;
        appendActivity(`Connected to Worker version ${payload.version}`, "success");
      } catch (error) {
        if (isAuthRequired(error)) {
          setSession(null);
          setAuthRequired(true);
          setFatalError("Sign in required to use the Explorer.");
          appendActivity("Authentication required. Click Sign in to start Cloudflare Access login.", "error");
          return;
        }
        const message = errorMessage(error);
        setFatalError(message);
        appendActivity(`Failed to load session info: ${message}`, "error");
      }
      if (sessionLoaded) {
        await refreshList();
      }
    };

    void bootstrap();
  }, [appendActivity, refreshList]);

  useEffect(() => {
    if (!selectedObject) {
      setShares([]);
      return;
    }
    void loadShares(selectedObject.key);
  }, [loadShares, selectedObject]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("input, textarea, select")) {
        return;
      }

      if (event.key === "/") {
        event.preventDefault();
        prefixInputRef.current?.focus();
        return;
      }

      if (event.key === "j") {
        event.preventDefault();
        moveSelection(1);
        return;
      }

      if (event.key === "k") {
        event.preventDefault();
        moveSelection(-1);
        return;
      }

      if (event.key === "Enter" && selectedObject) {
        event.preventDefault();
        openPreview(selectedObject.key);
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === "d" && selectedObject) {
        event.preventDefault();
        openDownload(selectedObject.key);
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === "p" && selectedObject) {
        event.preventDefault();
        openPreview(selectedObject.key);
        return;
      }

      if (event.shiftKey && event.key.toLowerCase() === "r" && selectedObject) {
        event.preventDefault();
        void performShareCreate();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveSelection, openDownload, openPreview, performShareCreate, selectedObject]);

  return (
    <div className="app-shell">
      <aside className="panel stack">
        <div className="panel-header">
          <h1 className="panel-title">R2 Explorer</h1>
          <span className={`badge ${session?.readonly ? "warning" : "success"}`}>
            {session?.readonly ? "Read-only" : "Read-write"}
          </span>
        </div>

        <div className="panel-content stack">
          <div className="stack">
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="subtle">Worker</span>
              <span className="mono muted">{session?.version ?? "-"}</span>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="subtle">Actor</span>
              <span className="mono muted" title={session?.actor.actor ?? ""}>
                {session?.actor.actor ?? "-"}
              </span>
            </div>
            <div className="row" style={{ justifyContent: "space-between" }}>
              <span className="subtle">Auth mode</span>
              <span className="badge">{session?.actor.mode ?? "unknown"}</span>
            </div>
            <div className="row">
              {authRequired ? (
                <button className="primary" onClick={startLogin}>
                  Sign in
                </button>
              ) : (
                <button className="ghost" onClick={signOut} disabled={!session}>
                  Sign out
                </button>
              )}
            </div>
          </div>

          <div className="stack">
            <h2 className="panel-title" style={{ fontSize: "0.86rem" }}>
              Keyboard Shortcuts
            </h2>
            <div className="shortcut-grid">
              <div className="shortcut-row">
                <span>Focus prefix</span>
                <span className="kbd">/</span>
              </div>
              <div className="shortcut-row">
                <span>Move selection</span>
                <span>
                  <span className="kbd">j</span> <span className="kbd">k</span>
                </span>
              </div>
              <div className="shortcut-row">
                <span>Preview object</span>
                <span className="kbd">Enter</span>
              </div>
              <div className="shortcut-row">
                <span>Download object</span>
                <span className="kbd">Shift+D</span>
              </div>
              <div className="shortcut-row">
                <span>Create share</span>
                <span className="kbd">Shift+R</span>
              </div>
            </div>
          </div>

          {fatalError ? <div className="badge danger">{fatalError}</div> : null}
        </div>
      </aside>

      <main className="stack" style={{ minWidth: 0 }}>
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Object Navigator</h2>
            <div className="row">
              <span className={`badge ${listComplete ? "success" : "warning"}`}>{listComplete ? "Page complete" : "More results"}</span>
            </div>
          </div>
          <div className="panel-content stack">
            <div className="row">
              <label htmlFor="prefix" className="subtle">
                Prefix
              </label>
              <input
                ref={prefixInputRef}
                id="prefix"
                className="mono"
                style={{ flex: "1 1 20rem" }}
                value={prefix}
                onChange={(event) => setPrefix(event.currentTarget.value)}
                placeholder="workspace/incident-logs/"
              />
              <button className="primary" onClick={() => void refreshList()} disabled={loadingList}>
                {loadingList ? "Refreshing" : "Refresh"}
              </button>
              <button className="ghost" onClick={() => setPrefix(parentPrefix(prefix))}>
                Up
              </button>
              <button className="ghost" onClick={() => void refreshList(cursor)} disabled={listComplete || loadingList || !cursor}>
                Next
              </button>
            </div>

            <div className="grid-two">
              <section className="panel" style={{ borderRadius: "14px" }}>
                <div className="panel-content stack" style={{ padding: "0.55rem" }}>
                  <table className="object-table mono">
                    <thead>
                      <tr>
                        <th style={{ width: "44%" }}>Key</th>
                        <th>Size</th>
                        <th>Uploaded</th>
                        <th>ETag</th>
                        <th style={{ width: "8rem" }}>Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {folders.map((folder) => (
                        <tr key={folder} onClick={() => setPrefix(folder)}>
                          <td title={folder}>{folder}</td>
                          <td>-</td>
                          <td>-</td>
                          <td>-</td>
                          <td>
                            <span className="badge">prefix</span>
                          </td>
                        </tr>
                      ))}
                      {objects.map((object) => (
                        <tr
                          key={object.key}
                          className={selectedKey === object.key ? "selected" : ""}
                          onClick={() => setSelectedKey(object.key)}
                        >
                          <td title={object.key}>{object.key}</td>
                          <td>{formatBytes(object.size)}</td>
                          <td>{formatWhen(object.uploaded)}</td>
                          <td title={object.etag}>{readEtag(object)}</td>
                          <td>
                            <span className="badge">object</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {folders.length === 0 && objects.length === 0 ? <div className="empty">No objects under this prefix.</div> : null}
                </div>
              </section>

              <section className="panel" style={{ borderRadius: "14px" }}>
                <div className="panel-header">
                  <h3 className="panel-title">Object Actions</h3>
                </div>
                <div className="panel-content stack right-scroll">
                  {!selectedObject ? (
                    <div className="empty">Select an object to inspect metadata and manage shares.</div>
                  ) : (
                    <>
                      <div className="stack">
                        <div className="mono" style={{ fontSize: "0.82rem", lineHeight: 1.45 }}>
                          {selectedObject.key}
                        </div>
                        <div className="row subtle" style={{ justifyContent: "space-between" }}>
                          <span>Size</span>
                          <span className="mono">{formatBytes(selectedObject.size)}</span>
                        </div>
                        <div className="row subtle" style={{ justifyContent: "space-between" }}>
                          <span>ETag</span>
                          <span className="mono">{readEtag(selectedObject)}</span>
                        </div>
                        <div className="row subtle" style={{ justifyContent: "space-between" }}>
                          <span>Uploaded</span>
                          <span className="mono">{formatWhen(selectedObject.uploaded)}</span>
                        </div>
                      </div>

                      <div className="row">
                        <button className="ghost" onClick={() => openPreview(selectedObject.key)}>
                          Preview
                        </button>
                        <button className="ghost" onClick={() => openDownload(selectedObject.key)}>
                          Download
                        </button>
                        <button className="ghost" onClick={() => void performObjectMove()} disabled={mutatingObject}>
                          Move
                        </button>
                        <button className="danger" onClick={() => void performObjectDelete()} disabled={mutatingObject}>
                          Delete
                        </button>
                      </div>

                      <div className="stack" style={{ borderTop: "1px solid var(--line-muted)", paddingTop: "0.8rem" }}>
                        <h4 className="panel-title" style={{ fontSize: "0.84rem" }}>
                          Share Tokens
                        </h4>
                        <div className="row">
                          <input
                            className="mono"
                            value={shareTtl}
                            onChange={(event) => setShareTtl(event.currentTarget.value)}
                            placeholder="24h"
                            style={{ width: "7rem" }}
                          />
                          <input
                            className="mono"
                            value={shareMaxDownloads}
                            onChange={(event) => setShareMaxDownloads(event.currentTarget.value)}
                            placeholder="max downloads"
                            style={{ width: "9rem" }}
                          />
                          <button className="primary" onClick={() => void performShareCreate()} disabled={creatingShare}>
                            {creatingShare ? "Creating" : "Create"}
                          </button>
                        </div>
                        {shareCreateResult ? (
                          <div className="stack" style={{ fontSize: "0.82rem" }}>
                            <a href={shareCreateResult.url} target="_blank" rel="noreferrer">
                              {shareCreateResult.url}
                            </a>
                            <div className="subtle mono">Token: {shareCreateResult.tokenId}</div>
                          </div>
                        ) : null}

                        <div className="stack">
                          {loadingShares ? <div className="subtle">Loading shares...</div> : null}
                          {!loadingShares && shares.length === 0 ? (
                            <div className="empty">No active shares for this object.</div>
                          ) : null}
                          {shares.map((share) => (
                            <div key={share.tokenId} className="upload-item stack" style={{ gap: "0.35rem" }}>
                              <div className="row" style={{ justifyContent: "space-between" }}>
                                <span className="mono" style={{ fontSize: "0.78rem" }}>
                                  {share.tokenId}
                                </span>
                                <span className={`badge ${share.revoked ? "danger" : "success"}`}>
                                  {share.revoked ? "revoked" : "active"}
                                </span>
                              </div>
                              <div className="subtle" style={{ fontSize: "0.76rem" }}>
                                expires {formatWhen(share.expiresAt)} | uses {share.downloadCount}/
                                {share.maxDownloads === 0 ? "inf" : share.maxDownloads}
                              </div>
                              <div className="row">
                                <a href={`/share/${encodeURIComponent(share.tokenId)}`} target="_blank" rel="noreferrer">
                                  Open link
                                </a>
                                <button className="danger" onClick={() => void performShareRevoke(share.tokenId)}>
                                  Revoke
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </section>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Multipart Upload Queue</h2>
            <span className="subtle">Direct browser-to-R2 signed part uploads</span>
          </div>
          <div className="panel-content stack">
            <div className="row">
              <input
                type="file"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (file) {
                    void enqueueUpload(file);
                    event.currentTarget.value = "";
                  }
                }}
              />
              <span className="subtle">Uploads target current prefix: <span className="mono">{prefix || "/"}</span></span>
            </div>
            {uploadItems.length === 0 ? <div className="empty">No uploads in this session.</div> : null}
            {uploadItems.map((item) => {
              const ratio = item.totalParts > 0 ? Math.min(100, Math.round((item.uploadedParts / item.totalParts) * 100)) : 0;
              return (
                <div key={item.id} className="upload-item stack">
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <div className="mono" style={{ fontSize: "0.82rem" }}>{item.fileName}</div>
                    <span className={`badge ${item.status === "done" ? "success" : item.status === "error" ? "danger" : "warning"}`}>
                      {item.status}
                    </span>
                  </div>
                  <div className="subtle" style={{ fontSize: "0.78rem" }}>{item.detail}</div>
                  <div className="progress">
                    <span style={{ width: `${ratio}%` }}></span>
                  </div>
                  <div className="subtle mono" style={{ fontSize: "0.74rem" }}>
                    {item.uploadedParts}/{item.totalParts || "-"} parts
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Activity</h2>
            <button className="ghost" onClick={() => setActivity([])}>
              Clear
            </button>
          </div>
          <div className="panel-content activity-log">
            {activity.length === 0 ? <div className="empty">Activity stream is empty.</div> : null}
            {activity.map((entry) => (
              <div key={entry.id} className="activity-entry">
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className={`badge ${entry.level === "success" ? "success" : entry.level === "error" ? "danger" : ""}`}>
                    {entry.level}
                  </span>
                  <span className="subtle mono" style={{ fontSize: "0.72rem" }}>{entry.timestamp}</span>
                </div>
                <div style={{ marginTop: "0.3rem" }}>{entry.message}</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
