/**
 * Multi-turn conversation support for submissions.
 *
 * A submission can hold an optional multi-turn conversation in addition to (or
 * instead of) the legacy single prompt/output pair. The shape is recorded in
 * `submissions.transcript_mode`:
 *
 *   - 'single' — legacy / simple case: one prompt + one output, stored ONLY in
 *     submissions.prompt / submissions.output. No submission_turns rows. Old
 *     rows (which predate this feature) are implicitly 'single'.
 *   - 'turns'  — the submitter entered alternating user/assistant boxes. Each
 *     turn is a row in submission_turns (role + content, ordered by turn_index).
 *   - 'block'  — the submitter pasted a whole exported conversation into one
 *     textarea, using `### User` / `### Assistant` delimiter lines. We split it
 *     into turns at submit time and store the resulting turns in submission_turns
 *     (so display/browse don't have to re-parse). If no delimiters are present
 *     the whole block becomes a single untagged 'user' turn.
 *
 * For BOTH 'turns' and 'block' we ALSO mirror a flattened view into the legacy
 * submissions.prompt / submissions.output columns (prompt = the first user turn,
 * output = the first assistant turn, or the whole text when there's no split).
 * This keeps the NOT NULL constraint satisfied and keeps the browse `q` LIKE
 * search (which scans prompt/output) working without a schema-wide rewrite.
 *
 * This module is pure (no DB access) so it can be unit-tested and reused by the
 * submit form, the dashboard edit form, the entry page, and the browse cards.
 */
import { h, raw, type SafeHtml } from "./html.ts";

export type TranscriptMode = "single" | "turns" | "block" | "link";
export type TurnRole = "user" | "assistant";

export interface Turn {
  role: TurnRole;
  content: string;
}

/** Caps shared by submit + edit. Per-turn content is capped at the legacy
 *  output limit; the whole conversation has a turn-count cap. */
export const MAX_TURNS = 100;
export const MAX_TURN_CONTENT = 32000;
/** Cap on the raw pasted block (mode B). Generous: ~the per-turn cap times a
 *  handful of turns, bounded so a single field can't blow the body size cap. */
export const MAX_BLOCK_LENGTH = 200000;

/**
 * Delimiter markers for the pasted-block mode. A line consisting of `### User`
 * (or `### Assistant`), optionally with surrounding whitespace and case-
 * insensitive, starts a new turn of that role. We also accept the bracketed
 * `<<USER>>` / `<<ASSISTANT>>` form for people pasting from other tools.
 */
const DELIM_RE = /^[ \t]*(?:#{1,6}[ \t]*|<<[ \t]*)(user|assistant)(?:[ \t]*>>)?[ \t]*:?[ \t]*$/i;

export const BLOCK_DELIMITERS_HELP = "### User / ### Assistant";

/** Optional submitter-supplied delimiter overrides for the pasted-block mode. */
export interface BlockDelimiters {
  user?: string;
  assistant?: string;
}

/** Normalize a delimiter string for comparison: trimmed, lower-cased. */
function normDelim(s: string | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

/**
 * Build a per-line role matcher. The built-in `### User` / `<<ASSISTANT>>` etc.
 * markers ALWAYS work (they're the documented standard). When the submitter
 * supplies custom delimiters, a line that equals one of them (trimmed, case-
 * insensitive) ALSO starts a turn of that role — additive, never replacing the
 * defaults.
 */
function makeDelimMatcher(custom?: BlockDelimiters): (line: string) => TurnRole | null {
  const u = normDelim(custom?.user);
  const a = normDelim(custom?.assistant);
  return (line: string): TurnRole | null => {
    if (u || a) {
      const t = line.trim().toLowerCase();
      // A custom user delimiter equal to the assistant one is ambiguous; user wins.
      if (u && t === u) return "user";
      if (a && t === a) return "assistant";
    }
    const m = DELIM_RE.exec(line);
    if (m) return m[1]!.toLowerCase() === "assistant" ? "assistant" : "user";
    return null;
  };
}

export function normalizeMode(s: string | null | undefined): TranscriptMode {
  return s === "turns" || s === "block" || s === "link" ? s : "single";
}

/**
 * Split a pasted conversation block into turns on the delimiter lines. Text
 * before the first delimiter (a preamble) is attached to a leading 'user' turn
 * so nothing is lost. If there are no delimiters at all, the entire block
 * becomes a single 'user' turn.
 */
export function splitBlock(block: string, custom?: BlockDelimiters): Turn[] {
  const lines = block.split(/\r?\n/);
  const turns: Turn[] = [];
  let current: Turn | null = null;
  const preamble: string[] = [];
  const matchDelim = makeDelimMatcher(custom);

  const flush = () => {
    if (current) {
      current.content = current.content.replace(/\s+$/, "");
      turns.push(current);
      current = null;
    }
  };

  for (const line of lines) {
    const role = matchDelim(line);
    if (role) {
      flush();
      current = { role, content: "" };
      continue;
    }
    if (current) {
      current.content += (current.content.length > 0 ? "\n" : "") + line;
    } else {
      preamble.push(line);
    }
  }
  flush();

  // Any text before the first delimiter becomes a leading user turn (so we don't
  // silently drop it). Trim its trailing whitespace to match the others.
  const preambleText = preamble.join("\n").replace(/\s+$/, "");
  if (preambleText.length > 0) {
    turns.unshift({ role: "user", content: preambleText });
  }

  // Drop empty turns that can arise from back-to-back delimiters.
  return turns.filter((t) => t.content.trim().length > 0);
}

/**
 * Derive the legacy prompt/output mirror from a turn list. prompt = first user
 * turn, output = first assistant turn. Falls back so neither column is ever
 * empty when there's any content at all (the columns are NOT NULL).
 */
export function deriveLegacyPair(turns: Turn[]): { prompt: string; output: string } {
  const firstUser = turns.find((t) => t.role === "user");
  const firstAssistant = turns.find((t) => t.role === "assistant");
  const prompt = firstUser?.content ?? turns[0]?.content ?? "";
  const output =
    firstAssistant?.content ??
    (turns.length > 1 ? turns[turns.length - 1]!.content : "") ??
    "";
  return { prompt, output };
}

/**
 * Validate a turn list for submit/edit. Returns the cleaned turns (empty turns
 * dropped, content trimmed) or an error message.
 */
export function validateTurns(
  turns: Turn[],
): { ok: true; turns: Turn[] } | { ok: false; error: string } {
  const cleaned = turns
    .map((t) => ({ role: t.role, content: t.content.replace(/\s+$/, "") }))
    .filter((t) => t.content.trim().length > 0);
  if (cleaned.length === 0) {
    return { ok: false, error: "Add at least one non-empty turn." };
  }
  if (cleaned.length > MAX_TURNS) {
    return { ok: false, error: `Too many turns (max ${MAX_TURNS}).` };
  }
  for (const t of cleaned) {
    if (t.content.length > MAX_TURN_CONTENT) {
      return { ok: false, error: `A turn is too long (max ${MAX_TURN_CONTENT} characters).` };
    }
  }
  return { ok: true, turns: cleaned };
}

/**
 * Parse the transcript portion of a submit/edit form. Handles both modes:
 *
 *   - mode 'turns': repeated `turn_role` + `turn_content` fields (paired by
 *     index — the Nth turn_role goes with the Nth turn_content). parseForm runs
 *     the body through URLSearchParams, so we read them via getAll().
 *   - mode 'block': a single `transcript_block` textarea, split on delimiters.
 *
 * `scrub` is the caller's sanitizeText()-based cleaner (applied per turn /
 * to the block). Returns the validated, cleaned turn list and the effective
 * mode, or an error message. The legacy single prompt/output path is handled
 * separately by callers (this is only invoked when mode is 'turns'/'block').
 */
export function readTranscriptForm(
  form: URLSearchParams,
  scrub: (raw: string) => string,
):
  | { ok: true; mode: TranscriptMode; turns: Turn[] }
  | { ok: false; error: string } {
  const mode = normalizeMode(form.get("transcript_mode"));

  if (mode === "block") {
    const block = scrub(form.get("transcript_block") ?? "");
    if (block.length > MAX_BLOCK_LENGTH) {
      return { ok: false, error: `The pasted conversation is too long (max ${MAX_BLOCK_LENGTH} characters).` };
    }
    const split = splitBlock(block, {
      user: scrub(form.get("block_user_delim") ?? "").slice(0, 80),
      assistant: scrub(form.get("block_assistant_delim") ?? "").slice(0, 80),
    });
    const v = validateTurns(split);
    if (!v.ok) return v;
    return { ok: true, mode: "block", turns: v.turns };
  }

  if (mode === "turns") {
    const roles = form.getAll("turn_role");
    const contents = form.getAll("turn_content");
    const turns: Turn[] = [];
    const n = Math.max(roles.length, contents.length);
    for (let i = 0; i < n; i++) {
      const role: TurnRole = (roles[i] ?? "user").toLowerCase() === "assistant" ? "assistant" : "user";
      const content = scrub(contents[i] ?? "");
      turns.push({ role, content });
    }
    const v = validateTurns(turns);
    if (!v.ok) return v;
    return { ok: true, mode: "turns", turns: v.turns };
  }

  // 'single' isn't handled here — callers use the legacy prompt/output fields.
  return { ok: false, error: "Unknown transcript mode." };
}

/** Label for a turn's role, given the total turn count. When there's a single
 *  turn we use the plain "Prompt"/"Response" wording so the common case reads
 *  like the legacy single-turn layout. */
export function turnLabel(role: TurnRole, simple: boolean): string {
  if (simple) return role === "assistant" ? "Response" : "Prompt";
  return role === "assistant" ? "Assistant" : "User";
}

/**
 * Whether a conversation is the simple legacy shape — a lone turn, or exactly
 * one user turn followed by one assistant turn — which should read
 * "Prompt"/"Response" rather than "User"/"Assistant".
 */
export function isSimplePair(turns: Turn[]): boolean {
  if (turns.length <= 1) return true;
  return (
    turns.length === 2 &&
    turns[0]!.role === "user" &&
    turns[1]!.role === "assistant"
  );
}

/**
 * Render the transcript portion of the submit / edit form: a mode toggle
 * (single | turns | block) plus the structured turn boxes and the pasted-block
 * textarea. Progressive enhancement lives in src/static/turns.js — with JS off,
 * all three blocks are present in the DOM and the server reads whichever the
 * chosen radio names. The "add turn" / "remove turn" buttons are plain submit
 * buttons (name="action") so they work without JS too: the server re-renders
 * the form with one more / one fewer turn box.
 *
 * `turns` seeds the structured boxes (always at least one row so the simple case
 * shows Prompt + Response). `block` seeds the textarea. `mode` selects the
 * active radio.
 */
export function renderTranscriptFields(opts: {
  mode: TranscriptMode;
  turns: Turn[];
  block: string;
  userDelim?: string;
  assistantDelim?: string;
}): SafeHtml {
  const { mode, block } = opts;
  const userDelim = opts.userDelim ?? "";
  const assistantDelim = opts.assistantDelim ?? "";
  // Always render at least one user + one assistant box so the default (no-JS)
  // form looks like the legacy single-turn layout.
  const seed = opts.turns.length > 0
    ? opts.turns
    : [
        { role: "user" as TurnRole, content: "" },
        { role: "assistant" as TurnRole, content: "" },
      ];

  const turnBox = (t: Turn, i: number): SafeHtml => h`
    <div class="turn-edit" data-turn>
      <div class="turn-edit-head">
        <label>Role
          <select name="turn_role">
            <option value="user" ${t.role === "user" ? raw("selected") : raw("")}>User</option>
            <option value="assistant" ${t.role === "assistant" ? raw("selected") : raw("")}>AI</option>
          </select>
        </label>
        <button type="submit" name="action" value="remove_turn:${raw(String(i))}"
                class="btn-secondary turn-remove" formnovalidate>Remove turn</button>
      </div>
      <textarea name="turn_content" rows="5" maxlength="${MAX_TURN_CONTENT}"
                placeholder="turn ${i + 1} text">${t.content}</textarea>
    </div>`;

  return h`
    <fieldset class="transcript-fields" data-transcript>
      <legend>Conversation</legend>
      <p class="field-hint"><small>Most entries are a single prompt + response — just
        fill in the two boxes below. For a back-and-forth chat, add more turns, or
        switch to "Paste a whole conversation" to drop in an exported transcript.</small></p>

      <div class="transcript-mode">
        <label class="checkbox-label">
          <input type="radio" name="transcript_mode" value="turns" ${mode !== "block" ? raw("checked") : raw("")}>
          Enter turns separately
        </label>
        <label class="checkbox-label">
          <input type="radio" name="transcript_mode" value="block" ${mode === "block" ? raw("checked") : raw("")}>
          Paste a whole conversation
        </label>
      </div>

      <div class="transcript-turns" data-turns-list>
        ${seed.map(turnBox)}
      </div>
      <div class="transcript-turns-actions">
        <button type="submit" name="action" value="add_turn" class="btn-secondary"
                data-add-turn formnovalidate>Add turn</button>
        <small class="field-hint">Up to ${MAX_TURNS} turns.</small>
      </div>

      <div class="transcript-block" data-block>
        <label for="transcript_block">Pasted conversation</label>
        <p class="field-hint"><small>Paste the whole conversation and mark each turn with a
          delimiter line: <code>### User</code> before a prompt and
          <code>### Assistant</code> before a response (each on its own line). We'll
          split it into turns automatically. No delimiters? We'll treat the whole
          thing as one block.</small></p>
        <textarea id="transcript_block" name="transcript_block" rows="14"
                  maxlength="${MAX_BLOCK_LENGTH}"
                  placeholder="### User&#10;What's 2+2?&#10;&#10;### Assistant&#10;5">${block}</textarea>
        <div class="block-delims">
          <p class="field-hint"><small>Pasting from a tool that uses different markers?
            Set your own here — the standard <code>### User</code> / <code>### Assistant</code>
            markers keep working alongside them. Match the marker lines exactly (case
            doesn't matter).</small></p>
          <div class="block-delim-row">
            <label for="block_user_delim">User delimiter
              <input type="text" id="block_user_delim" name="block_user_delim"
                     value="${userDelim}" maxlength="80" placeholder="### User"
                     autocomplete="off" spellcheck="false">
            </label>
            <label for="block_assistant_delim">AI delimiter
              <input type="text" id="block_assistant_delim" name="block_assistant_delim"
                     value="${assistantDelim}" maxlength="80" placeholder="### Assistant"
                     autocomplete="off" spellcheck="false">
            </label>
          </div>
        </div>
      </div>
    </fieldset>
  `;
}

/**
 * Apply a no-JS "add turn" / "remove turn:N" action (the `action` form field)
 * to a turn list, returning the new list. Used by the server-side fallback so
 * the form re-renders with one more / one fewer box when JS is off. Returns null
 * if `action` isn't a turn action.
 */
export function applyTurnAction(action: string, turns: Turn[]): Turn[] | null {
  if (action === "add_turn") {
    // Alternate the new turn's role from the last one for convenience.
    const lastRole = turns.length > 0 ? turns[turns.length - 1]!.role : "assistant";
    const nextRole: TurnRole = lastRole === "user" ? "assistant" : "user";
    return [...turns, { role: nextRole, content: "" }];
  }
  if (action.startsWith("remove_turn:")) {
    const idx = parseInt(action.slice("remove_turn:".length), 10);
    if (Number.isFinite(idx) && idx >= 0 && idx < turns.length) {
      const next = turns.filter((_, i) => i !== idx);
      return next.length > 0 ? next : [{ role: "user", content: "" }];
    }
    return turns;
  }
  return null;
}

/**
 * Serialize a transcript to a single string for the version-diff audit log.
 * Mode-prefixed handling: 'single' mode is tracked via prompt/output already,
 * so it serializes to null. Stable formatting for the others.
 */
export function serializeTranscript(mode: TranscriptMode, turns: Turn[]): string | null {
  // 'single' tracks via prompt/output; 'link' tracks via source_url — neither
  // has turn rows, so both serialize to null.
  if (mode === "single" || mode === "link") return null;
  if (turns.length === 0) return null;
  return turns.map((t) => `[${t.role}]\n${t.content}`).join("\n\n");
}

/**
 * Build the effective turn list for RENDERING any submission, regardless of
 * mode. For 'turns'/'block' rows we have explicit turn rows; for legacy/'single'
 * rows we synthesize a two-turn [user prompt, assistant output] list so every
 * renderer can treat a submission uniformly. The output turn is dropped when
 * it's empty (some legacy rows may have a blank one).
 */
export function effectiveTurns(
  mode: TranscriptMode,
  storedTurns: Turn[],
  prompt: string,
  output: string,
): Turn[] {
  if ((mode === "turns" || mode === "block") && storedTurns.length > 0) {
    return storedTurns;
  }
  const t: Turn[] = [];
  if (prompt.length > 0) t.push({ role: "user", content: prompt });
  if (output.length > 0) t.push({ role: "assistant", content: output });
  return t;
}

/**
 * Render a conversation as a vertical series of labeled, role-colored boxes.
 * Each turn's content is passed through `clamp` (the shared longField clamp from
 * browse.ts) so long turns collapse behind a pure-CSS "show all" — same no-JS
 * pattern used for single prompt/output today.
 *
 * `collapseThreshold`: when there are more than this many turns, the whole
 * conversation is wrapped in a <details> "show full conversation (N turns)"
 * toggle showing only the first two turns by default. Pass 0 to never collapse
 * the conversation wrapper (the entry page wants the whole thing expanded; the
 * browse/dashboard cards pass a small threshold to keep the listing cheap).
 */
export function renderConversation(
  turns: Turn[],
  clamp: (text: string) => SafeHtml,
  collapseThreshold = 0,
): SafeHtml {
  const total = turns.length;
  const simple = isSimplePair(turns);
  const box = (t: Turn, i: number): SafeHtml => h`
    <div class="turn turn-${raw(t.role)}">
      <div class="turn-label">${turnLabel(t.role, simple)}</div>
      <div class="entry-field-box">${clamp(t.content)}</div>
    </div>`;

  if (collapseThreshold > 0 && total > collapseThreshold) {
    const head = turns.slice(0, 2).map(box);
    const rest = turns.slice(2).map(box);
    return h`<div class="conversation">
      ${head}
      <details class="conversation-more">
        <summary><span class="more">show full conversation (${total} turns)</span><span class="less">show fewer turns</span></summary>
        ${rest}
      </details>
    </div>`;
  }

  return h`<div class="conversation">${turns.map(box)}</div>`;
}
