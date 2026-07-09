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
import { errorMessage, isAuthRequired, parentPrefix } from "../lib/format";
import type { ActivityLog } from "./useActivityLog";

const PAGE_LIMIT = 200;

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
  performMove: (target: string) => Promise<void>;
  performDelete: () => Promise<void>;
  performShareCreate: (ttl: string, maxDownloads: number) => Promise<void>;
  performShareRevoke: (tokenId: string) => Promise<void>;
};

type BrowserArgs = {
  log: Pick<ActivityLog, "append">;
  session: SessionInfoResponse | null;
  onAuthRequired: () => void;
  onAuthOk: () => void;
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
export function useObjectBrowser({ log, session, onAuthRequired, onAuthOk }: BrowserArgs): ObjectBrowser {
  const { append } = log;

  const [prefix, setPrefixState] = useState("");
  const [folders, setFolders] = useState<string[]>([]);
  const [objects, setObjects] = useState<ObjectMetadata[]>([]);
  const [selectedKey, setSelectedKeyState] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [listComplete, setListComplete] = useState(true);
  const [loadingList, setLoadingList] = useState(false);
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

  const bucketAlias = session?.buckets?.[0]?.alias ?? DEFAULT_BUCKET_ALIAS;

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
        const payload = await listObjects(targetPrefix, cursor, PAGE_LIMIT, controller.signal);
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
    [append, onAuthOk, onAuthRequired],
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

  const runMutation = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      setMutating(true);
      try {
        await action();
      } finally {
        setMutating(false);
      }
    },
    [],
  );

  const performMove = useCallback(
    (target: string) =>
      runMutation(async () => {
        const source = selectedKeyRef.current;
        if (!source || !target || target === source) {
          return;
        }
        try {
          await moveObject(source, target);
          append(`Moved ${source} to ${target}`, "success");
          setSelectedKey(target);
          await list(prefixRef.current, pageCursorRef.current);
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return;
          }
          append(`Move failed: ${errorMessage(error)}`, "error");
        }
      }),
    [append, list, onAuthRequired, runMutation, setSelectedKey],
  );

  const performDelete = useCallback(
    () =>
      runMutation(async () => {
        const key = selectedKeyRef.current;
        if (!key) {
          return;
        }
        try {
          await deleteObject(key);
          append(`Moved ${key} to .trash/`, "success");
          setSelectedKey(null);
          await list(prefixRef.current, pageCursorRef.current);
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return;
          }
          append(`Delete failed: ${errorMessage(error)}`, "error");
        }
      }),
    [append, list, onAuthRequired, runMutation, setSelectedKey],
  );

  const performShareCreate = useCallback(
    (ttl: string, maxDownloads: number) =>
      runMutation(async () => {
        const key = selectedKeyRef.current;
        if (!key) {
          return;
        }
        try {
          const created = await createShare(key, ttl, maxDownloads, bucketAlias);
          setShareCreateResult(created);
          append(`Created share ${created.tokenId} for ${key}`, "success");
          await loadShares(key);
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return;
          }
          append(`Share create failed: ${errorMessage(error)}`, "error");
        }
      }),
    [append, bucketAlias, loadShares, onAuthRequired, runMutation],
  );

  const performShareRevoke = useCallback(
    (tokenId: string) =>
      runMutation(async () => {
        try {
          await revokeShare(tokenId);
          append(`Revoked share ${tokenId}`, "success");
          const key = selectedKeyRef.current;
          if (key) {
            await loadShares(key);
          }
        } catch (error) {
          if (isAuthRequired(error)) {
            onAuthRequired();
            return;
          }
          append(`Share revoke failed: ${errorMessage(error)}`, "error");
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
