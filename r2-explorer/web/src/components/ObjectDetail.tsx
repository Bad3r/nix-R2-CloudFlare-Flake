import { useEffect, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ObjectMetadata, ShareCreateResponse, ShareRecord } from "../lib/api";
import { formatBytes, formatWhen, readEtag } from "../lib/format";
import { Badge, PanelHead } from "./primitives";

type ObjectDetailProps = {
  object: ObjectMetadata | null;
  shares: ShareRecord[];
  shareCreateResult: ShareCreateResponse | null;
  loadingShares: boolean;
  sharesError: string;
  mutating: boolean;
  onPreview: (key: string) => void;
  onDownload: (key: string) => void;
  onMove: (target: string) => void;
  onDelete: () => void;
  onShareCreate: (ttl: string, maxDownloads: number) => void;
  onShareRevoke: (tokenId: string) => void;
};

type Pending = "none" | "move" | "delete";

/** Metadata, destructive actions (inline-confirmed), and share-token management. */
export function ObjectDetail(props: ObjectDetailProps): JSX.Element {
  const { object, shares, shareCreateResult, loadingShares, sharesError, mutating } = props;
  const [pending, setPending] = useState<Pending>("none");
  const [moveTarget, setMoveTarget] = useState("");
  const [ttl, setTtl] = useState("24h");
  const [maxDownloads, setMaxDownloads] = useState("1");

  // Reset transient action UI whenever the inspected object changes.
  useEffect(() => {
    setPending("none");
    setMoveTarget(object?.key ?? "");
  }, [object?.key]);

  if (!object) {
    return (
      <section class="panel reveal" style={{ "--i": 2 }}>
        <PanelHead index="05" title="Inspector" />
        <div class="panel-body">
          <div class="empty">Select an object to inspect metadata and manage shares.</div>
        </div>
      </section>
    );
  }

  const submitShare = (event: Event): void => {
    event.preventDefault();
    const parsed = Number.parseInt(maxDownloads, 10);
    const normalized = Number.isFinite(parsed) && parsed >= 0 ? parsed : 1;
    props.onShareCreate(ttl.trim() || "24h", normalized);
  };

  return (
    <section class="panel reveal" style={{ "--i": 2 }}>
      <PanelHead index="05" title="Inspector" />
      <div class="panel-body stack">
        <div class="mono truncate" title={object.key} style={{ fontSize: "0.82rem", color: "var(--accent)" }}>
          {object.key}
        </div>

        <div class="kv">
          <div class="line">
            <span class="k">Size</span>
            <span class="v num">{formatBytes(object.size)}</span>
          </div>
          <div class="line">
            <span class="k">ETag</span>
            <span class="v num">{readEtag(object)}</span>
          </div>
          <div class="line">
            <span class="k">Uploaded</span>
            <span class="v num">{formatWhen(object.uploaded)}</span>
          </div>
        </div>

        <div class="row">
          <button type="button" class="btn ghost" onClick={() => props.onPreview(object.key)}>Preview</button>
          <button type="button" class="btn ghost" onClick={() => props.onDownload(object.key)}>Download</button>
          <button
            type="button"
            class="btn ghost"
            onClick={() => setPending((p) => (p === "move" ? "none" : "move"))}
            disabled={mutating}
          >
            Move
          </button>
          <button
            type="button"
            class="btn danger"
            onClick={() => setPending((p) => (p === "delete" ? "none" : "delete"))}
            disabled={mutating}
          >
            Delete
          </button>
        </div>

        {pending === "move" ? (
          <form
            class="inline-form"
            onSubmit={(event) => {
              event.preventDefault();
              const target = moveTarget.trim();
              if (target && target !== object.key) {
                props.onMove(target);
              }
              setPending("none");
            }}
          >
            <label class="tag" for="move-target">Move to key</label>
            <input
              id="move-target"
              value={moveTarget}
              autoFocus
              onInput={(event) => setMoveTarget(event.currentTarget.value)}
            />
            <div class="row">
              <button type="submit" class="btn primary" disabled={mutating}>Confirm move</button>
              <button type="button" class="btn ghost" onClick={() => setPending("none")}>Cancel</button>
            </div>
          </form>
        ) : null}

        {pending === "delete" ? (
          <div class="inline-form" role="alertdialog" aria-label="Confirm delete">
            <span class="dim" style={{ fontSize: "0.8rem" }}>
              Move <span class="mono">{object.key}</span> into <span class="mono">.trash/</span>?
            </span>
            <div class="row">
              <button
                type="button"
                class="btn danger"
                disabled={mutating}
                onClick={() => {
                  props.onDelete();
                  setPending("none");
                }}
              >
                Confirm delete
              </button>
              <button type="button" class="btn ghost" onClick={() => setPending("none")}>Cancel</button>
            </div>
          </div>
        ) : null}

        <div class="stack tight" style={{ borderTop: "1px solid var(--line)", paddingTop: "0.7rem" }}>
          <span class="tag">Share tokens</span>
          <form class="row" onSubmit={submitShare}>
            <input
              value={ttl}
              onInput={(event) => setTtl(event.currentTarget.value)}
              placeholder="24h"
              aria-label="Share time to live"
              style={{ width: "6rem" }}
            />
            <input
              value={maxDownloads}
              inputMode="numeric"
              onInput={(event) => setMaxDownloads(event.currentTarget.value)}
              placeholder="max"
              aria-label="Maximum downloads (0 for unlimited)"
              style={{ width: "6rem" }}
            />
            <button type="submit" class="btn primary" disabled={mutating}>Create</button>
          </form>

          {shareCreateResult ? (
            <div class="share-row">
              <a class="link-out" href={shareCreateResult.url} target="_blank" rel="noreferrer">
                {shareCreateResult.url}
              </a>
              <span class="faint mono" style={{ fontSize: "0.74rem" }}>token {shareCreateResult.tokenId}</span>
            </div>
          ) : null}

          {loadingShares ? <div class="tag">Loading shares…</div> : null}
          {sharesError ? <div class="alert" role="alert">{sharesError}</div> : null}
          {!loadingShares && !sharesError && shares.length === 0 ? (
            <div class="empty">No active shares for this object.</div>
          ) : null}

          {shares.map((share) => (
            <div class="share-row" key={share.tokenId}>
              <div class="spread">
                <span class="mono truncate" style={{ fontSize: "0.76rem" }}>{share.tokenId}</span>
                <Badge tone={share.revoked ? "danger" : "ok"}>{share.revoked ? "revoked" : "active"}</Badge>
              </div>
              <span class="faint" style={{ fontSize: "0.74rem" }}>
                expires {formatWhen(share.expiresAt)} · {share.downloadCount}/
                {share.maxDownloads === 0 ? "∞" : share.maxDownloads} downloads
              </span>
              <div class="row">
                <a class="link-out" href={`/share/${encodeURIComponent(share.tokenId)}`} target="_blank" rel="noreferrer">
                  Open link
                </a>
                {!share.revoked ? (
                  <button type="button" class="btn danger tiny" disabled={mutating} onClick={() => props.onShareRevoke(share.tokenId)}>
                    Revoke
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
