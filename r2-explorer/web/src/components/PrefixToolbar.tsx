import type { JSX, RefObject } from "preact";

type PrefixToolbarProps = {
  prefix: string;
  loading: boolean;
  canGoBack: boolean;
  canGoNext: boolean;
  inputRef: RefObject<HTMLInputElement>;
  onPrefixInput: (value: string) => void;
  onSubmit: () => void;
  onUp: () => void;
  onBack: () => void;
  onNext: () => void;
};

/**
 * Prefix entry and pagination controls. Editing the prefix is decoupled from
 * listing: the operator commits with Enter or the Go button, so typing no longer
 * floods the worker with list requests.
 */
export function PrefixToolbar({
  prefix,
  loading,
  canGoBack,
  canGoNext,
  inputRef,
  onPrefixInput,
  onSubmit,
  onUp,
  onBack,
  onNext,
}: PrefixToolbarProps): JSX.Element {
  const submit = (event: Event): void => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form class="row" onSubmit={submit} role="search">
      <label class="tag" for="prefix">
        Prefix
      </label>
      <input
        ref={inputRef}
        id="prefix"
        name="prefix"
        style={{ flex: "1 1 18rem", minWidth: "10rem" }}
        value={prefix}
        spellcheck={false}
        autocomplete="off"
        onInput={(event) => onPrefixInput(event.currentTarget.value)}
        placeholder="workspace/incident-logs/"
        aria-label="Object key prefix"
      />
      <button type="submit" class="btn primary" disabled={loading}>
        {loading ? "Listing…" : "Go"}
      </button>
      <button type="button" class="btn ghost" onClick={onUp} title="Parent prefix">
        Up
      </button>
      <button type="button" class="btn ghost" onClick={onBack} disabled={!canGoBack} title="Previous page">
        Back
      </button>
      <button type="button" class="btn ghost" onClick={onNext} disabled={!canGoNext} title="Next page">
        Next
      </button>
    </form>
  );
}
