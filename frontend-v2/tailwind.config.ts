import type { Config } from "tailwindcss";

/**
 * Ledger design tokens — see docs/DESIGN.md.
 *
 * Every colour is a CSS variable defined in src/styles/tokens.css, so dark
 * mode is one attribute flip rather than a `dark:` prefix on every element.
 * Do not add a raw hex value here; add it to tokens.css and reference it.
 */
/// A colour that accepts Tailwind's `/NN` alpha modifier.
///
/// `<alpha-value>` is the placeholder Tailwind substitutes: the opacity when
/// a modifier is present, `1` when it is not. A bare `var(--x)` has nowhere
/// to put it, so Tailwind discards the rule instead of warning.
const alpha = (token: string) => `rgb(var(${token}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: ["class", '[data-theme="dark"]'],
  theme: {
    /**
     * Tailwind's default screens stay. One is added.
     *
     * `settings` is the width at which the Settings dialog is wide enough for
     * its rows to put the label left and the control hard right. The dialog
     * is `max-w-[58rem]` (928px) with a 240px category sidebar, so the right
     * pane is ~600px while the viewport can afford the full dialog and
     * narrower below that. 1000px is where the pane drops under ~500px and a
     * long label starts meeting its control; under it, rows stack.
     *
     * A media query is the right tool only because the dialog's width is a
     * pure function of the viewport's. If the panel ever becomes resizable,
     * or moves into a split pane, this must become a container query -- the
     * plugin is not installed, so that would be a dependency add.
     */
    screens: {
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
      settings: "1000px"
    },
    // Replaced, not extended: an arbitrary Tailwind palette is how a design
    // system leaks. Only Ledger colours exist.
    colors: {
      transparent: "transparent",
      current: "currentColor",
      // Every colour is `rgb(var(--x-rgb) / <alpha-value>)`, never a bare
      // `var(--x)`.
      //
      // Tailwind 3 cannot interpolate an alpha modifier into a bare var():
      // it drops the whole declaration. Silently. `bg-ink/40` compiled to
      // nothing at all, which left the modal scrim fully transparent and
      // every primary and danger button without a hover or press state --
      // for as long as the colours were declared that way.
      //
      // The `--x-rgb` triplets live beside their hex in tokens.css and are
      // generated from it, so a retuned hex cannot drift from its triplet.
      // Keep this form for any colour added here, or the next `/NN` written
      // against it fails the same invisible way.
      paper: alpha("--paper-rgb"),
      surface: alpha("--surface-rgb"),
      sunken: alpha("--surface-sunken-rgb"),
      ink: alpha("--ink-rgb"),
      // Modal backdrop only. Does not invert with the theme -- see tokens.css.
      scrim: alpha("--scrim-rgb"),
      "ink-muted": alpha("--ink-muted-rgb"),
      "ink-faint": alpha("--ink-faint-rgb"),
      rule: alpha("--rule-rgb"),
      "rule-strong": alpha("--rule-strong-rgb"),
      seal: alpha("--seal-rgb"),
      "seal-wash": alpha("--seal-wash-rgb"),
      vermilion: alpha("--vermilion-rgb"),
      "vermilion-wash": alpha("--vermilion-wash-rgb"),
      "on-vermilion": alpha("--on-vermilion-rgb"),
      viridian: alpha("--viridian-rgb"),
      "viridian-wash": alpha("--viridian-wash-rgb"),
      amber: alpha("--amber-rgb"),
      "amber-wash": alpha("--amber-wash-rgb")
    },
    fontFamily: {
      // Reply body — the reply is a legal document and reads like one.
      serif: ["Newsreader", "Georgia", "Cambria", "serif"],
      // UI chrome.
      sans: ["Inter Tight", "Inter", "Segoe UI", "system-ui", "sans-serif"],
      // Section refs, circular numbers, ids, paths.
      mono: ["JetBrains Mono", "Cascadia Mono", "Consolas", "monospace"]
    },
    // 1.25 ratio off a 16px base.
    fontSize: {
      xs: ["0.75rem", { lineHeight: "1.4" }],
      sm: ["0.875rem", { lineHeight: "1.5" }],
      base: ["1rem", { lineHeight: "1.6" }],
      lg: ["1.25rem", { lineHeight: "1.45" }],
      xl: ["1.5625rem", { lineHeight: "1.3" }],
      "2xl": ["1.9375rem", { lineHeight: "1.2" }],
      "3xl": ["2.4375rem", { lineHeight: "1.15" }]
    },
    fontWeight: {
      normal: "400",
      medium: "500",
      semibold: "600"
    },
    spacing: {
      0: "0",
      px: "1px",
      1: "0.25rem",
      2: "0.5rem",
      3: "0.75rem",
      4: "1rem",
      6: "1.5rem",
      8: "2rem",
      12: "3rem",
      16: "4rem",
      24: "6rem"
    },
    borderRadius: {
      none: "0",
      // One radius per role, not one radius for everything.
      control: "6px",
      panel: "10px",
      full: "9999px"
    },
    borderWidth: {
      DEFAULT: "1px",
      0: "0",
      2: "2px"
    },
    // Panels are separated by rules, not shadows. The only shadows that exist
    // are for genuinely floating layers (popover, dialog).
    boxShadow: {
      none: "none",
      pop: "0 4px 16px -2px rgb(21 24 29 / 0.12), 0 1px 3px rgb(21 24 29 / 0.08)",
      dialog: "0 16px 48px -8px rgb(21 24 29 / 0.24)"
    },
    extend: {
      maxWidth: {
        // Reply measure. Serif body, so slightly over the 65ch sans ideal.
        measure: "72ch"
      },
      transitionTimingFunction: {
        ledger: "cubic-bezier(.2,.6,.2,1)"
      },
      transitionDuration: {
        120: "120ms",
        180: "180ms"
      },
      keyframes: {
        "tag-in": {
          from: { opacity: "0", transform: "translateX(-6px)" },
          to: { opacity: "1", transform: "translateX(0)" }
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(.98)" },
          to: { opacity: "1", transform: "scale(1)" }
        },
        // A dialog is centred by `-translate-x-1/2 -translate-y-1/2`, and an
        // animated `transform` REPLACES that for the whole animation -- with
        // `both`, permanently. `pop-in` therefore dropped every dialog's
        // top-left corner onto the viewport centre. The translate has to be
        // part of the keyframe, which is why this cannot just be `pop-in`.
        "dialog-in": {
          from: {
            opacity: "0",
            transform: "translate(-50%, -50%) scale(.98)"
          },
          to: { opacity: "1", transform: "translate(-50%, -50%) scale(1)" }
        }
      },
      animation: {
        // The one piece of choreography: a citation landing in the margin.
        "tag-in": "tag-in 180ms cubic-bezier(.2,.6,.2,1) both",
        "pop-in": "pop-in 120ms cubic-bezier(.2,.6,.2,1) both",
        "dialog-in": "dialog-in 120ms cubic-bezier(.2,.6,.2,1) both"
      }
    }
  },
  plugins: []
} satisfies Config;
