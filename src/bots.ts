/** 0.501.0: AI "bot" authors. A bot is just a regular author record with a
 *  stable id + name and `bot: true` — so it can be stamped as a note's author
 *  or contributor exactly like a person, but is flagged 🤖 and excluded from
 *  team notifications (you don't want "Claude added a note" pinging coworkers).
 *
 *  Ids must satisfy parseAuthorRef's `[a-z0-9]{4,12}` shape (types.ts), so no
 *  hyphens/uppercase. These are the seed suggestions; the user can enable a
 *  subset and add custom bots — the registry (with bot:true) is the source of
 *  which bots actually exist. */
export interface BotDef { id: string; name: string; }

export const DEFAULT_BOTS: BotDef[] = [
  { id: "botclaude", name: "Claude" },
  { id: "botchatgpt", name: "ChatGPT" },
  { id: "botgemini", name: "Gemini" },
  { id: "botcopilot", name: "Copilot" },
  { id: "botgrok", name: "Grok" },
];
