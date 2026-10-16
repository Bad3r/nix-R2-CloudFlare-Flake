import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  createShare,
  deleteObject,
  DEFAULT_BUCKET_ALIAS,
  isAbortError,
  listObjects,
  listShares,
  moveObject,
  revokeShare,
  type ObjectMetadata,
  type SessionInfoResponse,
  type ShareCreateResponse,
  type ShareRecord,
} from "../lib/api";
import { errorMessage, isAuthRequired, isObjectExistsError, objectExistsKey, parentPrefix, resolveListLimit } from "../lib/format";
import type { ActivityLog } from "./useActivityLog";

/** Outcome of a mutation, reported back to the caller instead of only logged. */
export type MutationOutcome = { ok: true } | { ok: false; message: string; conflictKey?: string };

export type ObjectBrowser = {
  prefix: string;
  folders: string[];
  objects: ObjectMetadata[];
  selectedKey: string | null;
  selectedObject: ObjectMetadata | null;
  selectedIndex: number;
  listComplete: boolean;
  loadingList: boolean;
  listError: string;
  canGoBack: boolean;
  canGoNext: boolean;
  shares: ShareRecord[];
  loadingShares: boolean;
  sharesError: string;
  shareCreateResult: ShareCreateResponse | null;
  mutating: boolean;
  setPrefix: (value: string) => void;
  navigateTo: (prefix: string) => void;
  goUp: () => void;
  goBack: () => void;
  goNext: () => void;
  refresh: () => void;
  select: (key: string) => void;
  moveSelection: (delta: number) => void;
  performMove: (target: string, overwrite?: boolean) => Promise<MutationOutcome>;
  performDelete: () => Promise<MutationOutcome>;
  performShareCreate: (ttl: string, maxDownloads: number) => Promise<MutationOutcome>;
  performShareRevoke: (tokenId: string) => Promise<MutationOutcome>;
};

type BrowserArgs = {
  log: Pick<ActivityLog, "append">;
  onAuthRequired: () => void;
  onAuthOk: () => void;
  session: SessionInfoResponse | null;
};

/**
 * Owns object listing, selection, paging, and share management for one bucket.
 *
 * Correctness guarantees:
 * - Overlapping list/share requests are cancelled and guarded by a monotonic
 *   sequence id, so a slow stale response can never overwrite a newer view.
 * - Async mutations read the live prefix/selection via refs, avoiding the stale
 *   closures that previously reset the selection after a move.
 * - Paging keeps a cursor stack so Back is lossless, not forward-only.
 */
export function useObjectBrowser({ log, onAuthRequired, onAuthOk, session }: BrowserArgs): ObjectBrowser {
  const { append } = log;

  const [prefix, setPrefixState] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [objects, setObjects] = useState<ObjectMetadata[]>([]);
  const [selectedKey, setSelectedKeyState] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [listComplete, setListComplete] = useState(true);
  // Starts true so the table shows its loading state, never a false "no
  // objects" claim, before the first list() attempt has even started (e.g.
  // while session bootstrap is still resolving).
  const [loadingList, setLoadingList] = useState(true);
  const [listError, setListError] = useState("");
  const [pageStack, setPageStack] = useState<Array<string | undefined>>([]);

  const [shares, setShares] = useState<ShareRecord[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const [sharesError, setSharesError] = useState("");
  const [shareCreateResult, setShareCreateResult] = useState<ShareCreateResponse | null>(null);
  const [mutating, setMutating] = useState(false);

  const prefixRef = useRef("");
  const selectedKeyRef = useRef<string | null>(null);
  const pageCursorRef = useRef<string | undefined>(undefined);
  const listSeqRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const shareSeqRef = useRef(0);
  const shareAbortRef = useRef<AbortController | null>(null);

  // The object browser always lists FILES_BUCKET (the /api/v2/list route is
  // hardcoded to it), so share create/list must target the matching "files"
  // alias. Selecting session.buckets[0] picked the alphabetically-first
  // configured alias (listBucketBindings sorts by alias), which misrouted
  // shares to a bucket whose alias sorts before "files".
  const bucketAlias = DEFAULT_BUCKET_ALIAS;

  // Abort in-flight reads on unmount so late responses cannot resolve against
  // a disposed component (mirrors useSessionBootstrap's cleanup).
  useEffect(
    () => () => {
      listAbortRef.current?.abort();
      shareAbortRef.current?.abort();
    },
    [],
  );

  const selectedObject = useMemo(
    () => objects.find((object) => object.key === selectedKey) ?? null,
    [objects, selectedKey],
  );
  const selectedIndex = useMemo(
    () => (selectedKey ? objects.findIndex((object) => object.key === selectedKey) : -1),
    [objects, selectedKey],
  );

  const setPrefix = useCallback((value: string) => {
    prefixRef.current = value;
    setPrefixState(value);
  }, []);

  const setSelectedKey = useCallback((value: string | null) => {
    selectedKeyRef.current = value;
    setSelectedKeyState(value);
  }, []);

  const list = useCallback(
    async (targetPrefix: string, cursor: string | undefined): Promise<void> => {
      listAbortRef.current?.abort();
      const controller = new AbortController();
      listAbortRef.current = controller;
      const seq = (listSeqRef.current += 1);
      pageCursorRef.current = cursor;
      setLoadingList(true);
      setListError("");
      try {
        const limit = resolveListLimit(session);
        const payload = await listObjects(targetPrefix, cursor, limit, controller.signal);
        if (seq !== listSeqRef.current) {
          return;
        }
        onAuthOk();
        setFolders(payload.delimitedPrefixes);
        setObjects(payload.objects);
        setNextCursor(payload.cursor);
        setListComplete(payload.listComplete);
        setSelectedKeyState((prev) => {
          const keep = prev && payload.objects.some((object) => object.key === prev);
          const next = keep ? prev : (payload.objects[0]?.key ?? null);
          selectedKeyRef.current = next;
          return next;
        });
        append(
          `Listed ${payload.objects.length} objects, ${payload.delimitedPrefixes.length} prefixes under "${targetPrefix || "/"}"`,
          "success",
        );
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        // Staleness first: a superseded request must make no state transition
        // at all, or a slow stale 401 could flip a healthy view to sign-in.
        if (seq !== listSeqRef.current) {
          return;
        }
        if (isAuthRequired(error)) {
          onAuthRequired();
          return;
        }
        const message = errorMessage(error);
        setListError(message);
        append(`List failed: ${message}`, "error");
      } finally {
        if (seq === listSeqRef.current) {
          setLoadingList(false);
        }
      }
    },
    [append, onAuthOk, onAuthRequired, session],
  );

  const refresh = useCallback(() => {
    setPageStack([]);
    void list(prefixRef.current, undefined);
  }, [list]);

  const navigateTo = useCallback(
    (next: string) => {
      setPrefix(next);
      setPageStack([]);
      void list(next, undefined);
    },
    [list, setPrefix],
  );

  const goUp = useCallback(() => {
    navigateTo(parentPrefix(prefixRef.current));
  }, [navigateTo]);

  const goNext = useCallback(() => {
    if (listComplete || !nextCursor) {
      return;
    }
    setPageStack((stack) => [...stack, pageCursorRef.current]);
    void list(prefixRef.current, nextCursor);
  }, [list, listComplete, nextCursor]);

  const goBack = useCallback(() => {
    // Read the stack from state and keep the updater pure: fetching inside
    // the setPageStack callback would run a side effect per updater call.
    if (pageStack.length === 0) {
      return;
    }
    const previous = pageStack[pageStack.length - 1];
    setPageStack(pageStack.slice(0, -1));
    void list(prefixRef.current, previous);
  }, [list, pageStack]);

  const select = useCallback(
    (key: string) => {
      setSelectedKey(key);
    },
    [setSelectedKey],
  );

  const moveSelection = useCallback(
    (delta: number) => {
      if (objects.length === 0) {
        return;
      }
      const base = selectedIndex >= 0 ? selectedIndex : 0;
      const next = Math.min(objects.length - 1, Math.max(0, base + delta));
      setSelectedKey(objects[next].key);
    },
    [objects, selectedIndex, setSelectedKey],
  );

  const loadShares = useCallback(
    async (key: string): Promise<void> => {
      shareAbortRef.current?.abort();
      const controller = new AbortController();
      shareAbortRef.current = controller;
      const seq = (shareSeqRef.current += 1);
      setLoadingShares(true);
      setSharesError("");
      try {
        const payload = await listShares(key, bucketAlias, controller.signal);
        if (seq !== shareSeqRef.current) {
          return;
        }
        setShares(payload.shares);
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }
        // Staleness first, as in list(): stale failures must not touch state.
        if (seq !== shareSeqRef.current) {
          return;
        }
        if (isAuthRequired(error)) {
          onAuthRequired();
          return;
        }
        setShares([]);
        setSharesError(errorMessage(error));
        append(`Share listing failed: ${errorMessage(error)}`, "error");
      } finally {
        if (seq === shareSeqRef.current) {
          setLoadingShares(false);
        }
      }
    },
    [append, bucketAlias, onAuthRequired],
  );

  // Reset share panel and reload shares whenever the selection changes.
  useEffect(() => {
    setShareCreateResult(null);
    if (!selectedKey) {
      setShares([]);
      setSharesError("");
      return;
    }
    void loadShares(selectedKey);
  }, [loadShares, selectedKey]);

  const runMutation = useCallback(async <T>(action: () => Promise<T>): Promise<T> => {
    setMutating(true);
    try {
      return await action();
    } finally {
      setMutating(false);
    }
  }, []);

  const performMove = useCallback(
    (target: string, overwrite = false) =>
      runMutation(async (): Promise<MutationOutcome> => {
        const source = selectedKeyRef.current;
        if (!source || !target || target === source) {
          return { ok: true };
        }
        try {
          await moveObject(source, target, overwrite);
          append(`Moved ${source} to ${target}`, "success");
          setSelectedKey(target);
          await list(prefixRef.current, pageCursorRef.current);
          return { ok: true };
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return { ok: false, message: errorMessage(error) };
          }
          const message = errorMessage(error);
          if (isObjectExistsError(error)) {
            const conflictKey = objectExistsKey(error) ?? target;
            append(`Move needs confirmation: an object already exists at ${conflictKey}`, "info");
            return { ok: false, message, conflictKey };
          }
          append(`Move failed: ${message}`, "error");
          return { ok: false, message };
        }
      }),
    [append, list, onAuthRequired, runMutation, setSelectedKey],
  );

  const performDelete = useCallback(
    () =>
      runMutation(async (): Promise<MutationOutcome> => {
        const key = selectedKeyRef.current;
        if (!key) {
          return { ok: true };
        }
        try {
          await deleteObject(key);
          append(`Moved ${key} to .trash/`, "success");
          setSelectedKey(null);
          await list(prefixRef.current, pageCursorRef.current);
          return { ok: true };
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return { ok: false, message: errorMessage(error) };
          }
          const message = errorMessage(error);
          append(`Delete failed: ${message}`, "error");
          return { ok: false, message };
        }
      }),
    [append, list, onAuthRequired, runMutation, setSelectedKey],
  );

  const performShareCreate = useCallback(
    (ttl: string, maxDownloads: number) =>
      runMutation(async (): Promise<MutationOutcome> => {
        const key = selectedKeyRef.current;
        if (!key) {
          return { ok: true };
        }
        try {
          const created = await createShare(key, ttl, maxDownloads, bucketAlias);
          setShareCreateResult(created);
          append(`Created share ${created.tokenId} for ${key}`, "success");
          await loadShares(key);
          return { ok: true };
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return { ok: false, message: errorMessage(error) };
          }
          const message = errorMessage(error);
          append(`Share create failed: ${message}`, "error");
          return { ok: false, message };
        }
      }),
    [append, bucketAlias, loadShares, onAuthRequired, runMutation],
  );

  const performShareRevoke = useCallback(
    (tokenId: string) =>
      runMutation(async (): Promise<MutationOutcome> => {
        try {
          await revokeShare(tokenId);
          append(`Revoked share ${tokenId}`, "success");
          const key = selectedKeyRef.current;
          if (key) {
            await loadShares(key);
          }
          return { ok: true };
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return { ok: false, message: errorMessage(error) };
          }
          const message = errorMessage(error);
          append(`Share revoke failed: ${message}`, "error");
          return { ok: false, message };
        }
      }),
    [append, loadShares, onAuthRequired, runMutation],
  );

  return {
    prefix,
    folders,
    objects,
    selectedKey,
    selectedObject,
    selectedIndex,
    listComplete,
    loadingList,
    listError,
    canGoBack: pageStack.length > 0,
    canGoNext: !listComplete && Boolean(nextCursor),
    shares,
    loadingShares,
    sharesError,
    shareCreateResult,
    mutating,
    setPrefix,
    navigateTo,
    goUp,
    goBack,
    goNext,
    refresh,
    select,
    moveSelection,
    performMove,
    performDelete,
    performShareCreate,
    performShareRevoke,
  };
}
