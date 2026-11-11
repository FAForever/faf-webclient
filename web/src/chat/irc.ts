// IRC wire format: the parts the Chat tab needs, following the Rust client's
// crates/faf-app/src/infra/irc.rs. One line per WebSocket frame, no CR LF.

export interface IrcLine {
  tags: Record<string, string>;
  /** The nick of `nick!user@host`, or the server name. */
  source: string;
  command: string;
  params: string[];
}

function unescapeTag(value: string): string {
  return value.replace(/\\(.)/g, (_, c: string) => ({ ":": ";", s: " ", r: "\r", n: "\n", "\\": "\\" })[c] ?? c);
}

export function parseLine(raw: string): IrcLine | null {
  let rest = raw.replace(/[\r\n]+$/, "");
  const tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    for (const part of rest.slice(1, end).split(";")) {
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq < 0) tags[part] = "";
      else tags[part.slice(0, eq)] = unescapeTag(part.slice(eq + 1));
    }
    rest = rest.slice(end + 1).trimStart();
  }
  let source = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    const prefix = rest.slice(1, end);
    source = prefix.split("!")[0].split("@")[0];
    rest = rest.slice(end + 1).trimStart();
  }
  const params: string[] = [];
  let command = "";
  while (rest.length) {
    if (rest.startsWith(":") && command) {
      params.push(rest.slice(1));
      break;
    }
    const end = rest.indexOf(" ");
    const word = end < 0 ? rest : rest.slice(0, end);
    if (!command) command = word.toUpperCase();
    else params.push(word);
    rest = end < 0 ? "" : rest.slice(end + 1).trimStart();
  }
  if (!command) return null;
  return { tags, source, command, params };
}

/** A line to send. The last parameter is made trailing when it needs to be. */
export function formatLine(command: string, ...params: string[]): string {
  const clean = params.map((p) => p.replace(/[\r\n\0]/g, " "));
  const last = clean.length - 1;
  return [command, ...clean.map((p, i) => (i === last && (p === "" || p.includes(" ") || p.startsWith(":")) ? `:${p}` : p))].join(" ");
}

/** SASL PLAIN: authzid NUL authcid NUL password, base64 of the UTF-8 bytes. */
export function saslPlain(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`\0${username}\0${password}`);
  let text = "";
  bytes.forEach((b) => (text += String.fromCharCode(b)));
  return btoa(text);
}

/** mIRC colours and styles out: the chat shows plain text. */
export function stripFormatting(text: string): string {
  return text
    .replace(/\x03(\d{1,2}(,\d{1,2})?)?/g, "")
    .replace(/\x04([0-9a-fA-F]{6}(,[0-9a-fA-F]{6})?)?/g, "")
    .replace(/[\x02\x0F\x11\x16\x1D\x1E\x1F]/g, "");
}

export const isChannel = (name: string) => /^[#&]/.test(name);

/** CTCP ACTION (/me) unwrapped, or null for an ordinary message. */
export function ctcpAction(text: string): string | null {
  const match = /^\x01ACTION ?(.*?)\x01?$/.exec(text);
  return match ? match[1] : null;
}

export const isCtcp = (text: string) => text.startsWith("\x01");
