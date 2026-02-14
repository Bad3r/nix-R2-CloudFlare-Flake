export function renderAppHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>R2 Explorer</title>
    <style>
      :root {
        --bg: #0f172a;
        --panel: #111827;
        --panel-2: #1f2937;
        --text: #e5e7eb;
        --muted: #94a3b8;
        --accent: #22c55e;
        --danger: #ef4444;
        --line: #334155;
      }
      * {
        box-sizing: border-box;
      }
      body {
        margin: 0;
        font-family: "JetBrains Mono", "Iosevka", monospace;
        background: radial-gradient(circle at top left, #1e293b, var(--bg) 55%);
        color: var(--text);
      }
      header {
        padding: 1rem;
        border-bottom: 1px solid var(--line);
        background: rgba(15, 23, 42, 0.9);
        position: sticky;
        top: 0;
        backdrop-filter: blur(5px);
      }
      main {
        padding: 1rem;
        display: grid;
        gap: 1rem;
      }
      section {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 10px;
        padding: 1rem;
      }
      .row {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
        align-items: center;
      }
      input,
      button,
      select {
        background: var(--panel-2);
        color: var(--text);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 0.45rem 0.6rem;
      }
      button {
        cursor: pointer;
      }
      button.primary {
        border-color: var(--accent);
      }
      button.danger {
        border-color: var(--danger);
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        padding: 0.4rem;
        border-bottom: 1px solid var(--line);
        text-align: left;
        vertical-align: top;
        word-break: break-all;
      }
      .muted {
        color: var(--muted);
      }
      .pill {
        border: 1px solid var(--line);
        border-radius: 999px;
        padding: 0.1rem 0.5rem;
        font-size: 0.8rem;
      }
      #log {
        white-space: pre-wrap;
        max-height: 240px;
        overflow: auto;
      }
      @media (max-width: 720px) {
        th:nth-child(3),
        td:nth-child(3),
        th:nth-child(4),
        td:nth-child(4) {
          display: none;
        }
      }
    </style>
  </head>
  <body>
    <header>
      <div class="row">
        <strong>R2 Explorer</strong>
        <span class="pill">Stage 5</span>
        <span id="identity" class="muted"></span>
      </div>
    </header>
    <main>
      <section>
        <div class="row">
          <label for="prefix">Prefix:</label>
          <input id="prefix" type="text" value="" style="min-width: 18rem" />
          <button id="refresh" class="primary">Refresh</button>
          <button id="up">Up</button>
          <span id="cursor-state" class="muted"></span>
          <button id="next">Next Page</button>
        </div>
      </section>

      <section>
        <div class="row">
          <label for="upload-file">Upload:</label>
          <input id="upload-file" type="file" />
          <button id="upload">Multipart Upload</button>
          <span id="upload-status" class="muted"></span>
        </div>
      </section>

      <section>
        <h3 style="margin-top: 0">Objects</h3>
        <table>
          <thead>
            <tr>
              <th>Key</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th>ETag</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody id="objects"></tbody>
        </table>
      </section>

      <section>
        <h3 style="margin-top: 0">Share Tokens</h3>
        <div id="shares" class="muted">Select a file and click "Shares".</div>
      </section>

      <section>
        <h3 style="margin-top: 0">Activity</h3>
        <div id="log" class="muted"></div>
      </section>
    </main>

    <script>
      (function () {
        const CHUNK_BYTES = 8 * 1024 * 1024;
        const prefixInput = document.getElementById("prefix");
        const refreshBtn = document.getElementById("refresh");
        const upBtn = document.getElementById("up");
        const nextBtn = document.getElementById("next");
        const cursorState = document.getElementById("cursor-state");
        const objectsBody = document.getElementById("objects");
        const uploadFileInput = document.getElementById("upload-file");
        const uploadBtn = document.getElementById("upload");
        const uploadStatus = document.getElementById("upload-status");
        const logBox = document.getElementById("log");
        const sharesBox = document.getElementById("shares");
        const identityBox = document.getElementById("identity");

        let cursor = "";
        let truncated = false;

        function log(message) {
          const stamp = new Date().toISOString();
          logBox.textContent = "[" + stamp + "] " + message + "\\n" + logBox.textContent;
        }

        async function api(path, init) {
          const response = await fetch(path, init);
          const text = await response.text();
          let payload = null;
          if (text.length > 0) {
            try {
              payload = JSON.parse(text);
            } catch (_error) {
              payload = { raw: text };
            }
          }
          if (!response.ok) {
            const message = payload && payload.error ? payload.error.message : response.statusText;
            throw new Error(message + " (status " + response.status + ")");
          }
          return payload;
        }

        function bytes(value) {
          if (typeof value !== "number" || Number.isNaN(value)) {
            return "-";
          }
          if (value < 1024) return value + " B";
          if (value < 1024 * 1024) return (value / 1024).toFixed(1) + " KiB";
          if (value < 1024 * 1024 * 1024) return (value / (1024 * 1024)).toFixed(2) + " MiB";
          return (value / (1024 * 1024 * 1024)).toFixed(2) + " GiB";
        }

        function setPrefix(value) {
          prefixInput.value = value;
          cursor = "";
        }

        function parentPrefix(prefix) {
          if (!prefix) return "";
          const clean = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
          const idx = clean.lastIndexOf("/");
          if (idx === -1) return "";
          return clean.slice(0, idx + 1);
        }

        async function refresh(resetCursor) {
          if (resetCursor) {
            cursor = "";
          }
          const prefix = prefixInput.value;
          const query = new URLSearchParams();
          query.set("prefix", prefix);
          if (cursor) query.set("cursor", cursor);
          query.set("limit", "200");

          const payload = await api("/api/list?" + query.toString());
          renderList(payload);
        }

        function renderList(payload) {
          objectsBody.innerHTML = "";
          const prefixes = payload.delimitedPrefixes || [];
          prefixes.forEach((p) => {
            const tr = document.createElement("tr");
            const key = document.createElement("td");
            key.textContent = p;
            const size = document.createElement("td");
            size.textContent = "-";
            const uploaded = document.createElement("td");
            uploaded.textContent = "-";
            const etag = document.createElement("td");
            etag.textContent = "-";
            const actions = document.createElement("td");
            const openBtn = document.createElement("button");
            openBtn.textContent = "Open";
            openBtn.onclick = function () {
              setPrefix(p);
              refresh(true).catch((error) => log("Open failed: " + error.message));
            };
            actions.appendChild(openBtn);
            tr.appendChild(key);
            tr.appendChild(size);
            tr.appendChild(uploaded);
            tr.appendChild(etag);
            tr.appendChild(actions);
            objectsBody.appendChild(tr);
          });

          (payload.objects || []).forEach((obj) => {
            const tr = document.createElement("tr");
            const key = document.createElement("td");
            key.textContent = obj.key;
            const size = document.createElement("td");
            size.textContent = bytes(obj.size);
            const uploaded = document.createElement("td");
            uploaded.textContent = obj.uploaded || "-";
            const etag = document.createElement("td");
            etag.textContent = obj.etag || "-";
            const actions = document.createElement("td");

            function addAction(label, fn, danger) {
              const btn = document.createElement("button");
              btn.textContent = label;
              if (danger) btn.className = "danger";
              btn.onclick = fn;
              actions.appendChild(btn);
            }

            addAction("Preview", function () {
              window.open("/api/preview?key=" + encodeURIComponent(obj.key), "_blank", "noopener");
            });
            addAction("Download", function () {
              window.open("/api/download?key=" + encodeURIComponent(obj.key), "_blank", "noopener");
            });
            addAction("Rename", async function () {
              const target = window.prompt("Destination key", obj.key);
              if (!target || target === obj.key) return;
              await api("/api/object/move", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ fromKey: obj.key, toKey: target }),
              });
              log("Moved " + obj.key + " -> " + target);
              await refresh(true);
            });
            addAction("Delete", async function () {
              if (!window.confirm("Move " + obj.key + " to .trash/?")) return;
              const payload = await api("/api/object/delete", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ key: obj.key }),
              });
              log("Deleted " + obj.key + " to " + payload.trashKey);
              await refresh(true);
            }, true);
            addAction("Create share", async function () {
              const ttl = window.prompt("TTL (e.g. 24h, 7d)", "24h") || "24h";
              const maxDownloadsRaw = window.prompt("Max downloads (0 = unlimited)", "0") || "0";
              const payload = await api("/api/share/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                  bucket: "files",
                  key: obj.key,
                  ttl: ttl,
                  maxDownloads: Number(maxDownloadsRaw),
                }),
              });
              log("Share created: " + payload.url);
              await showShares("files", obj.key);
            });
            addAction("List shares", async function () {
              await showShares("files", obj.key);
            });

            tr.appendChild(key);
            tr.appendChild(size);
            tr.appendChild(uploaded);
            tr.appendChild(etag);
            tr.appendChild(actions);
            objectsBody.appendChild(tr);
          });

          truncated = !payload.listComplete;
          cursor = payload.cursor || "";
          cursorState.textContent = truncated ? "More pages available" : "End of list";
          nextBtn.disabled = !truncated;
          if (payload.identity && typeof payload.identity === "object") {
            identityBox.textContent =
              "Identity: " + payload.identity.actor + " (" + payload.identity.mode + ")";
          } else if (typeof payload.identity === "string") {
            identityBox.textContent = "Identity: " + payload.identity;
          } else {
            identityBox.textContent = "Identity: unknown";
          }
        }

        async function showShares(bucket, key) {
          const query = new URLSearchParams({ bucket: bucket, key: key });
          const payload = await api("/api/share/list?" + query.toString());
          sharesBox.innerHTML = "";
          const title = document.createElement("div");
          title.textContent = "Shares for " + key;
          sharesBox.appendChild(title);

          const shares = payload.shares || [];
          if (shares.length === 0) {
            const empty = document.createElement("div");
            empty.className = "muted";
            empty.textContent = "No active shares. Use Create share to mint a new token.";
            sharesBox.appendChild(empty);
            return;
          }

          shares.forEach((share) => {
            const row = document.createElement("div");
            row.className = "row";
            const link = document.createElement("a");
            link.href = "/share/" + encodeURIComponent(share.tokenId);
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = share.tokenId;
            const meta = document.createElement("span");
            meta.className = "muted";
            meta.textContent =
              "exp=" +
              share.expiresAt +
              " downloads=" +
              share.downloadCount +
              "/" +
              (share.maxDownloads === 0 ? "inf" : share.maxDownloads) +
              " revoked=" +
              String(share.revoked);
            const revoke = document.createElement("button");
            revoke.textContent = "Revoke";
            revoke.className = "danger";
            revoke.onclick = async function () {
              await api("/api/share/revoke", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ tokenId: share.tokenId }),
              });
              log("Revoked share " + share.tokenId);
              await showShares(bucket, key);
            };
            row.appendChild(link);
            row.appendChild(meta);
            row.appendChild(revoke);
            sharesBox.appendChild(row);
          });
        }

        async function multipartUpload(file, key) {
          uploadStatus.textContent = "init";
          const initPayload = await api("/api/upload/init", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ key: key, contentType: file.type || "application/octet-stream" }),
          });

          const uploadId = initPayload.uploadId;
          const parts = [];
          let partNumber = 1;
          try {
            for (let offset = 0; offset < file.size; offset += CHUNK_BYTES) {
              const chunk = file.slice(offset, offset + CHUNK_BYTES);
              uploadStatus.textContent = "part " + partNumber;
              const params = new URLSearchParams({
                key: key,
                uploadId: uploadId,
                partNumber: String(partNumber),
              });
              const partPayload = await api("/api/upload/part?" + params.toString(), {
                method: "POST",
                body: chunk,
              });
              parts.push({ partNumber: partNumber, etag: partPayload.etag });
              partNumber += 1;
            }

            uploadStatus.textContent = "complete";
            await api("/api/upload/complete", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key: key, uploadId: uploadId, parts: parts }),
            });
          } catch (error) {
            uploadStatus.textContent = "abort";
            await api("/api/upload/abort", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ key: key, uploadId: uploadId }),
            }).catch(function (abortError) {
              log("Abort failed: " + abortError.message);
            });
            throw error;
          }
        }

        refreshBtn.onclick = function () {
          refresh(true).catch(function (error) {
            log("Refresh failed: " + error.message);
          });
        };
        upBtn.onclick = function () {
          setPrefix(parentPrefix(prefixInput.value));
          refresh(true).catch(function (error) {
            log("Parent navigation failed: " + error.message);
          });
        };
        nextBtn.onclick = function () {
          if (!truncated) return;
          refresh(false).catch(function (error) {
            log("Next page failed: " + error.message);
          });
        };
        uploadBtn.onclick = async function () {
          const file = uploadFileInput.files && uploadFileInput.files[0];
          if (!file) {
            log("Select a file to upload first.");
            return;
          }
          const key = (prefixInput.value || "") + file.name;
          try {
            await multipartUpload(file, key);
            uploadStatus.textContent = "done";
            log("Uploaded " + key);
            await refresh(true);
          } catch (error) {
            uploadStatus.textContent = "failed";
            log("Upload failed: " + error.message);
          }
        };

        refresh(true).catch(function (error) {
          log("Initial load failed: " + error.message);
        });
      })();
    </script>
  </body>
</html>
`;
}
