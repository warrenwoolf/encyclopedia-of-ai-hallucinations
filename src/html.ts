/**
 * HTML escaping helpers. Single source of truth for XSS safety.
 *
 *   h`<p>Hello ${userName}</p>`
 *   h`<ul>${entries.map(e => h`<li>${e.name}</li>`)}</ul>`
 *   h`<div>${raw("<strong>trusted</strong>")}</div>`
 *
 * Rules:
 *   - All HTML rendering goes through `h\`...\`` or `raw(...)`. No string concat.
 *   - `raw()` is ONLY for constants you fully control. Never on user input.
 *   - Final rendering to a string for the HTTP body goes through `renderToString()`.
 */

const ESCAPE_LOOKUP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escape(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[&<>"']/g, (c) => ESCAPE_LOOKUP[c]!);
}

/** Trusted HTML fragment — already escaped/composed by `h` or `raw`. */
export class SafeHtml {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

/** Mark a constant string as trusted HTML. Never call on user input. */
export function raw(s: string): SafeHtml {
  return new SafeHtml(s);
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return "";
  if (value instanceof SafeHtml) return value.value;
  if (Array.isArray(value)) return value.map(render).join("");
  return escape(value);
}

/**
 * Tagged template for HTML. All `${...}` interpolations are escaped unless they
 * are themselves `SafeHtml` (i.e. produced by `h\`...\`` or `raw(...)`).
 */
export function h(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += render(values[i]) + (strings[i + 1] ?? "");
  }
  return new SafeHtml(out);
}

/** Render to a plain string for the HTTP body. */
export function renderToString(value: SafeHtml | string): string {
  if (value instanceof SafeHtml) return value.value;
  // Plain strings are NOT trusted — escape defensively.
  return escape(value);
}
