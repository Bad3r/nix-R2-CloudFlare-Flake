import { useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import type { ObjectMetadata, ShareCreateResponse, ShareRecord } from "../lib/api";
import type { MutationOutcome } from "../hooks/useObjectBrowser";
import { formatBytes, formatWhen, normalizeShareTtl, parseMaxDownloads, readEtag } from "../lib/format";
import { Badge, PanelHead } from "./primitives";

type ObjectDetailProps = {
  object: ObjectMetadata | null;
  shares: ShareRecord[];
  shareCreateResult: ShareCreateResponse | null;
  loadingShares: boolean;
  sharesError: string;
  mutating: boolean;
  shareTtl: string;
  onShareTtlChange: (value: string) => void;
  shareMaxDownloads: string;
  onShareMaxDownloadsChange: (value: string) => void;
  onPreview: (key: string) => void;
  onDownload: (key: string) => void;
  onMove: (target: string, overwrite?: boolean) => Promise<MutationOutcome>;
  onDelete: () => Promise<MutationOutcome>;
  onShareCreate: (ttl: string, maxDownloads: number) => Promise<MutationOutcome>;
  onShareRevoke: (tokenId: string) => Promise<MutationOutcome>;
};

type Pending = "none" | "move" | "delete";

/** Metadata, destructive actions (inline-confirmed), and share-token management. */
export function ObjectDetail(props: ObjectDetailProps): JSX.Element {
  const { object, shares, shareCreateResult, loadingShares, sharesError, mutating, shareTtl, shareMaxDownloads } = props;
  const [pending, setPending] = useState<Pending>("none");
  const [moveTarget, setMoveTarget] = useState("");
  const [moveConflictKey, setMoveConflictKey] = useState<string | null>(null);
  const [moveError, setMoveError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [shareTtlError, setShareTtlError] = useState("");
  const [shareMaxDownloadsError, setShareMaxDownloadsError] = useState("");
  const [shareError, setShareError] = useState("");

  const deleteTriggerRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousPendingRef = useRef<Pending>("none");

  // Reset transient action UI whenever the inspected object changes.
  useEffect(() => {
    setPending("none");
    setMoveTarget(object?.key ?? "");
    setMoveConflictKey(null);
    setMoveError("");
    setDeleteError("");
    setShareTtlError("");
    setShareError("");
  }, [object?.key]);

  // Move focus into the delete confirm dialog on open (Cancel, the least
  // destructive action) and back to its trigger once it fully closes, per
  // the alertdialog pattern; Escape-to-cancel is wired on the dialog below.
  // A successful delete unmounts the trigger with the object, so focus then
  // lands on the panel itself instead of falling back to <body>.
  useEffect(() => {
    const previous = previousPendingRef.current;
    previousPendingRef.current = pending;
    if (pending === "delete") {
      deleteCancelRef.current?.focus();
    } else if (previous === "delete" && pending === "none") {
      (deleteTriggerRef.current ?? panelRef.current)?.focus();
    }
  }, [pending]);

  if (!object) {
    return (
      <section class="panel reveal" style={{ "--i": 2 }} ref={panelRef} tabIndex={-1}>
        <PanelHead index="05" title="Inspector" />
        <div class="panel-body">
          <div class="empty">Select an object to inspect metadata and manage shares.</div>
        </div>
      </section>
    );
  }

  const submitMove = async (event: Event): Promise<void> => {
    event.preventDefault();
    const target = moveTarget.trim();
    if (!target || target === object.key) {
      setPending("none");
      return;
    }
    setMoveError("");
    const result = await props.onMove(target);
    if (result.ok) {
      setMoveConflictKey(null);
      setPending("none");
      return;
    }
    if (result.conflictKey) {
      setMoveConflictKey(result.conflictKey);
      return;
    }
    setMoveError(result.message);
  };

  const confirmOverwriteMove = async (): Promise<void> => {
    if (!moveConflictKey) {
      return;
    }
    const result = await props.onMove(moveConflictKey, true);
    if (result.ok) {
      setMoveConflictKey(null);
      setPending("none");
      return;
    }
    if (result.conflictKey) {
      setMoveConflictKey(result.conflictKey);
      return;
    }
    setMoveConflictKey(null);
    setMoveError(result.message);
  };

  const confirmDelete = async (): Promise<void> => {
    setDeleteError("");
    const result = await props.onDelete();
    if (result.ok) {
      setPending("none");
    } else {
      setDeleteError(result.message);
    }
  };

  const submitShare = async (event: Event): Promise<void> => {
    event.preventDefault();
    const ttlResult = normalizeShareTtl(shareTtl);
    if (!ttlResult.ok) {
      setShareTtlError(ttlResult.message);
      return;
    }
    setShareTtlError("");
    const maxDownloadsResult = parseMaxDownloads(shareMaxDownloads);
    if (!maxDownloadsResult.ok) {
      setShareMaxDownloadsError(maxDownloadsResult.message);
      return;
    }
    setShareMaxDownloadsError("");
    setShareError("");
    const result = await props.onShareCreate(ttlResult.value, maxDownloadsResult.value);
    if (!result.ok) {
      setShareError(result.message);
    }
  };

  const revoke = async (tokenId: string): Promise<void> => {
    setShareError("");
    const result = await props.onShareRevoke(tokenId);
    if (!result.ok) {
      setShareError(`Revoke failed for ${tokenId}: ${result.message}`);
    }
  };

  return (
    <section class="panel reveal" style={{ "--i": 2 }} ref={panelRef} tabIndex={-1}>
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
            ref={deleteTriggerRef}
            onClick={() => setPending((p) => (p === "delete" ? "none" : "delete"))}
            disabled={mutating}
          >
            Delete
          </button>
        </div>

        {pending === "move" ? (
          <form class="inline-form" onSubmit={submitMove}>
            <label class="tag" for="move-target">Move to key</label>
            <input
              id="move-target"
              value={moveTarget}
              autoFocus
              disabled={mutating}
              onInput={(event) => {
                setMoveTarget(event.currentTarget.value);
                setMoveConflictKey(null);
                setMoveError("");
              }}
            />
            {moveConflictKey ? (
              <div class="alert" role="alert">
                <div>
                  An object already exists at <span class="mono">{moveConflictKey}</span>. Overwriting keeps a copy
                  of the existing object in <span class="mono">.trash/</span>.
                </div>
                <div class="row">
                  <button type="button" class="btn danger tiny" disabled={mutating} onClick={confirmOverwriteMove}>
                    Overwrite
                  </button>
                  <button type="button" class="btn ghost tiny" onClick={() => setMoveConflictKey(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
            {moveError ? <div class="alert" role="alert">{moveError}</div> : null}
            <div class="row">
              <button type="submit" class="btn primary" disabled={mutating}>Confirm move</button>
              <button type="button" class="btn ghost" onClick={() => setPending("none")}>Cancel</button>
            </div>
          </form>
        ) : null}

        {pending === "delete" ? (
          <div
            class="inline-form"
            role="alertdialog"
            aria-label="Confirm delete"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setPending("none");
              }
            }}
          >
            <span class="dim" style={{ fontSize: "0.8rem" }}>
              Move <span class="mono">{object.key}</span> into <span class="mono">.trash/</span>?
            </span>
            {deleteError ? <div class="alert" role="alert">{deleteError}</div> : null}
            <div class="row">
              <button type="button" class="btn danger" disabled={mutating} onClick={confirmDelete}>
                Confirm delete
              </button>
              <button type="button" class="btn ghost" ref={deleteCancelRef} onClick={() => setPending("none")}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        <div class="stack tight" style={{ borderTop: "1px solid var(--line)", paddingTop: "0.7rem" }}>
          <span class="tag">Share tokens</span>
          <form class="row" onSubmit={submitShare}>
            <input
              value={shareTtl}
              onInput={(event) => {
                props.onShareTtlChange(event.currentTarget.value);
                setShareTtlError("");
              }}
              placeholder="24h"
              aria-label="Share time to live"
              style={{ width: "6rem" }}
            />
            <input
              value={shareMaxDownloads}
              inputMode="numeric"
              onInput={(event) => {
                props.onShareMaxDownloadsChange(event.currentTarget.value);
                setShareMaxDownloadsError("");
              }}
              placeholder="max"
              aria-label="Maximum downloads (0 for unlimited)"
              style={{ width: "6rem" }}
            />
            <button type="submit" class="btn primary" disabled={mutating}>Create</button>
          </form>
          <div class="faint" style={{ fontSize: "0.72rem" }}>
            Format: number plus unit, s/m/h/d (for example 24h or 7d).
          </div>
          {shareTtlError ? <div class="alert" role="alert">{shareTtlError}</div> : null}
          {shareMaxDownloadsError ? <div class="alert" role="alert">{shareMaxDownloadsError}</div> : null}
          {shareError ? <div class="alert" role="alert">{shareError}</div> : null}

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
                  <button type="button" class="btn danger tiny" disabled={mutating} onClick={() => revoke(share.tokenId)}>
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
