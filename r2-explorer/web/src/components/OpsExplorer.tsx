import { useCallback, useEffect, useRef } from "preact/hooks";
import type { JSX } from "preact";
import { ACCESS_API_BOOTSTRAP_PATH } from "../lib/api";
import { useActivityLog } from "../hooks/useActivityLog";
import { useSessionBootstrap } from "../hooks/useSessionBootstrap";
import { useObjectBrowser } from "../hooks/useObjectBrowser";
import { useUploadQueue } from "../hooks/useUploadQueue";
import { useKeyboardNav } from "../hooks/useKeyboardNav";
import { StatusBar } from "./StatusBar";
import { SessionPanel } from "./SessionPanel";
import { ShortcutsPanel } from "./ShortcutsPanel";
import { UploadPanel } from "./UploadPanel";
import { PrefixToolbar } from "./PrefixToolbar";
import { ObjectTable } from "./ObjectTable";
import { ObjectDetail } from "./ObjectDetail";
import { ActivityLog } from "./ActivityLog";

const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

/**
 * Composition root for the operator console. Owns no business logic itself:
 * state lives in focused hooks and rendering in focused components. Wiring only.
 */
export function OpsExplorer(): JSX.Element {
  const log = useActivityLog();
  const sessionState = useSessionBootstrap(log);
  const { session, authRequired, fatalError, ready, setAuthRequired } = sessionState;

  const onAuthRequired = useCallback(() => setAuthRequired(true), [setAuthRequired]);
  const onAuthOk = useCallback(() => setAuthRequired(false), [setAuthRequired]);

  const browser = useObjectBrowser({ log, session, onAuthRequired, onAuthOk });

  // Live mirrors so async callbacks read current values without churny deps.
  const prefixRef = useRef(browser.prefix);
  prefixRef.current = browser.prefix;
  const refreshRef = useRef(browser.refresh);
  refreshRef.current = browser.refresh;

  const getCurrentPrefix = useCallback(() => prefixRef.current, []);
  const onUploaded = useCallback(() => refreshRef.current(), []);
  const uploads = useUploadQueue({ log, getCurrentPrefix, onUploaded });

  const prefixInputRef = useRef<HTMLInputElement>(null);

  const startLogin = useCallback(() => {
    window.location.assign(ACCESS_API_BOOTSTRAP_PATH);
  }, []);
  const signOut = useCallback(() => {
    window.location.assign(ACCESS_LOGOUT_PATH);
  }, []);

  const openObject = useCallback(
    (route: "preview" | "download", key: string) => {
      if (authRequired) {
        startLogin();
        return;
      }
      window.open(`/api/v2/${route}?key=${encodeURIComponent(key)}`, "_blank", "noopener,noreferrer");
    },
    [authRequired, startLogin],
  );
  const preview = useCallback((key: string) => openObject("preview", key), [openObject]);
  const download = useCallback((key: string) => openObject("download", key), [openObject]);

  // Initial listing runs once after an authenticated session is established.
  const didInitialList = useRef(false);
  useEffect(() => {
    if (ready && session && !authRequired && !didInitialList.current) {
      didInitialList.current = true;
      refreshRef.current();
    }
  }, [ready, session, authRequired]);

  useKeyboardNav(
    {
      focusPrefix: () => prefixInputRef.current?.focus(),
      moveDown: () => browser.moveSelection(1),
      moveUp: () => browser.moveSelection(-1),
      preview: () => browser.selectedKey && preview(browser.selectedKey),
      download: () => browser.selectedKey && download(browser.selectedKey),
      createShare: () => browser.performShareCreate("24h", 1),
      hasSelection: Boolean(browser.selectedObject),
    },
    prefixInputRef,
  );

  return (
    <div class="console">
      <StatusBar session={session} authRequired={authRequired} ready={ready} />

      <div class="workspace">
        <div class="rail">
          <SessionPanel
            session={session}
            authRequired={authRequired}
            fatalError={fatalError}
            onSignIn={startLogin}
            onSignOut={signOut}
          />
          <ShortcutsPanel />
          <UploadPanel
            uploads={uploads.uploads}
            prefix={browser.prefix}
            onEnqueue={uploads.enqueue}
            onCancel={uploads.cancel}
            onClearFinished={uploads.clearFinished}
          />
        </div>

        <div class="main">
          <section class="panel reveal" style={{ "--i": 0 }}>
            <div class="panel-body">
              <PrefixToolbar
                prefix={browser.prefix}
                loading={browser.loadingList}
                canGoBack={browser.canGoBack}
                canGoNext={browser.canGoNext}
                inputRef={prefixInputRef}
                onPrefixInput={browser.setPrefix}
                onSubmit={browser.refresh}
                onUp={browser.goUp}
                onBack={browser.goBack}
                onNext={browser.goNext}
              />
            </div>
          </section>

          <div class="browser">
            <ObjectTable
              folders={browser.folders}
              objects={browser.objects}
              selectedKey={browser.selectedKey}
              loading={browser.loadingList}
              error={browser.listError}
              onOpenFolder={browser.navigateTo}
              onSelect={browser.select}
              onActivate={preview}
            />
            <ObjectDetail
              object={browser.selectedObject}
              shares={browser.shares}
              shareCreateResult={browser.shareCreateResult}
              loadingShares={browser.loadingShares}
              sharesError={browser.sharesError}
              mutating={browser.mutating}
              onPreview={preview}
              onDownload={download}
              onMove={browser.performMove}
              onDelete={browser.performDelete}
              onShareCreate={browser.performShareCreate}
              onShareRevoke={browser.performShareRevoke}
            />
          </div>

          <ActivityLog activity={log.activity} onClear={log.clear} />
        </div>
      </div>
    </div>
  );
}
