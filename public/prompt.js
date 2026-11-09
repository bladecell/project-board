// Shared by the page and the CLI. Only id and title go in: card text is untrusted, the agent reads it through the tool.
const maxTitle = 120;

export const promptTitle = (t) => {
  const s = String(t ?? "").replace(/\p{Cc}+/gu, " ").replace(/[\u2028\u2029]+/g, " ").replace(/["`\\]+/g, "'").replace(/\s+/g, " ").trim();
  return s.length > maxTitle ? `${s.slice(0, maxTitle - 1).trimEnd()}…` : s;
};

const approved = new Set(["todo", "in-progress"]);

export const buildPrompt = (card) => {
  const id = Number(card.id);
  const title = promptTitle(card.title);
  if (approved.has(card.column) || card.column === undefined) {
    return `Work on board card #${id}: "${title}". Read it with the board_show MCP tool (or run \`board show ${id}\`), claim it (claim_card / \`board start ${id}\`), follow the Board workflow in CLAUDE.md or AGENTS.md, and when finished move it to verify with notes on what you ran and the result. If there is anything I should check by hand, put it in How to verify as \`- [ ]\` lines, one per check (move_to_verify howToVerify, set_how_to_verify, or \`board move ${id} verify --steps\`), not in the verify notes; the notes are for what you ran and the result. Do not move it to done.`;
  }
  return `Look at board card #${id}: "${title}". It is not approved yet. Read it with the board_show MCP tool (or run \`board show ${id}\`) and investigate: report what it involves, open questions, risks and a proposed plan. Do not claim it, do not change any files, and do not move it.`;
};
