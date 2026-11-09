// Shared by the page and the CLI. Only id and title go in: card text is untrusted, the agent reads it through the tool.
const maxTitle = 120;

export const promptTitle = (t) => {
  const s = String(t ?? "").replace(/\p{Cc}+/gu, " ").replace(/[\u2028\u2029]+/g, " ").replace(/["`\\]+/g, "'").replace(/\s+/g, " ").trim();
  return s.length > maxTitle ? `${s.slice(0, maxTitle - 1).trimEnd()}…` : s;
};

export const buildPrompt = (card) => {
  const id = Number(card.id);
  return `Work on board card #${id}: "${promptTitle(card.title)}". Read it with the board_show MCP tool (or run \`board show ${id}\`), claim it (claim_card / \`board start ${id}\`), follow the Board workflow in CLAUDE.md or AGENTS.md, and when finished move it to verify with notes on what you ran and the result. If there is anything I should check by hand, add it to the verify notes as `- [ ]` tick boxes, one per check. Do not move it to done.`;
};
