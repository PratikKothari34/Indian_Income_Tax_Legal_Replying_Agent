/**
 * The native file picker, for the Settings model-path fields.
 *
 * Why this exists: the only way to point v2 at a `.gguf` used to be typing an
 * absolute Windows path into a text field, from memory, with no validation
 * until the next draft failed. The dialog plugin was already registered in
 * `lib.rs`, already permitted in `capabilities/default.json`, and already
 * installed in `node_modules` — it was simply never called.
 *
 * It lives here rather than on `window.localAgent` because
 * `@tauri-apps/plugin-dialog` is a renderer-side API: routing it through a
 * new Tauri command would add a host round-trip and widen the bridge surface
 * for nothing.
 */

import { isTauri } from "@/lib/bridge";

export type PickFileOptions = {
  title: string;
  /** Extensions without the dot, e.g. `["gguf"]`. */
  extensions: readonly string[];
  /** What the filter is called in the dialog's own dropdown. */
  filterName: string;
  /** Pre-selects the folder holding this file, when it is set. */
  startingAt?: string;
};

/**
 * Opens the picker and resolves to an absolute path, or `null` when the user
 * cancels or there is no host.
 *
 * Never throws: a picker that fails should leave the user typing a path, not
 * staring at an error. The caller treats `null` as "nothing chosen", which is
 * also exactly what a cancel means.
 */
export async function pickFile(
  options: PickFileOptions
): Promise<string | null> {
  if (!isTauri()) {
    return null;
  }
  try {
    // Dynamic, matching TitleBar's reasoning: the module touches Tauri
    // internals on load and `npm run dev:web` has none.
    const { open } = await import("@tauri-apps/plugin-dialog");

    const selected = await open({
      title: options.title,
      multiple: false,
      directory: false,
      defaultPath: parentDirectory(options.startingAt),
      filters: [
        {
          name: options.filterName,
          extensions: [...options.extensions]
        }
      ]
    });

    // The plugin returns `string | string[] | null` depending on `multiple`.
    // Narrowed rather than cast: a future flip of `multiple` should be a type
    // error here, not an array stringified into a path field.
    if (typeof selected === "string") {
      return selected;
    }
    if (Array.isArray(selected)) {
      return selected[0] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The folder a path sits in, so the dialog reopens where the user last was.
 *
 * Handles both separators: the config may hold either on Windows, and the
 * user may have pasted a forward-slash path by hand.
 */
function parentDirectory(path: string | undefined): string | undefined {
  if (!path) {
    return undefined;
  }
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  // `cut <= 0` covers both "no separator" and a leading-slash path with no
  // real parent; `undefined` lets the dialog choose its own default.
  return cut > 0 ? path.slice(0, cut) : undefined;
}
