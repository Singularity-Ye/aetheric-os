import fs from 'fs';
import path from 'path';

const filePath = path.resolve('src/aetheric/AethericShellView.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Change renderContext from private to public
content = content.replace("private renderContext(): void {", "public renderContext(): void {");

// 2. Fix createDiv style parameters
const oldSnippet = `        if (isUser) {
          msgEl.setAttribute("style", "align-self: flex-end; max-width: 85%; margin-bottom: 2px; text-align: right;");
          const span = msgEl.createSpan({ cls: "aos-chat-bubble-user" });
          span.setAttribute("style", "background: rgba(169, 111, 23, 0.12); padding: 4px 8px; border-radius: 8px 8px 0px 8px; display: inline-block; word-break: break-word; border: 1px solid rgba(169, 111, 23, 0.2);");
          span.createDiv({ text: text, style: "font-weight: 500;" });
          span.createDiv({ text: time, style: "font-size: 8px; color: var(--aos-ink-muted); margin-top: 2px;" });
        } else {
          msgEl.setAttribute("style", "align-self: flex-start; max-width: 85%; margin-bottom: 2px; text-align: left;");
          const span = msgEl.createSpan({ cls: "aos-chat-bubble-agent" });
          const isGold = !isSystem;
          span.setAttribute("style", "background: var(--aos-surface-muted); padding: 4px 8px; border-radius: 8px 8px 8px 0px; display: inline-block; word-break: break-word; border: 1px solid var(--aos-border); color: " + (isGold ? "var(--aos-gold)" : "var(--aos-ink-muted)") + ";");
          span.createDiv({ text: text });
          span.createDiv({ text: sender + " · " + time, style: "font-size: 8px; color: var(--aos-ink-muted); margin-top: 2px;" });
        }`;

const newSnippet = `        if (isUser) {
          msgEl.setAttribute("style", "align-self: flex-end; max-width: 85%; margin-bottom: 2px; text-align: right;");
          const span = msgEl.createSpan({ cls: "aos-chat-bubble-user" });
          span.setAttribute("style", "background: rgba(169, 111, 23, 0.12); padding: 4px 8px; border-radius: 8px 8px 0px 8px; display: inline-block; word-break: break-word; border: 1px solid rgba(169, 111, 23, 0.2);");
          const textEl = span.createDiv({ text: text });
          textEl.style.fontWeight = "500";
          const timeEl = span.createDiv({ text: time });
          timeEl.setAttribute("style", "font-size: 8px; color: var(--aos-ink-muted); margin-top: 2px;");
        } else {
          msgEl.setAttribute("style", "align-self: flex-start; max-width: 85%; margin-bottom: 2px; text-align: left;");
          const span = msgEl.createSpan({ cls: "aos-chat-bubble-agent" });
          const isGold = !isSystem;
          span.setAttribute("style", "background: var(--aos-surface-muted); padding: 4px 8px; border-radius: 8px 8px 8px 0px; display: inline-block; word-break: break-word; border: 1px solid var(--aos-border); color: " + (isGold ? "var(--aos-gold)" : "var(--aos-ink-muted)") + ";");
          span.createDiv({ text: text });
          const timeEl = span.createDiv({ text: sender + " · " + time });
          timeEl.setAttribute("style", "font-size: 8px; color: var(--aos-ink-muted); margin-top: 2px;");
        }`;

// Standardize line endings to avoid replacement issues
const normalize = str => str.replace(/\r\n/g, '\n').trim();

if (normalize(content).includes(normalize(oldSnippet))) {
  content = content.replace(oldSnippet, newSnippet);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log("TS errors successfully patched in AethericShellView.ts!");
} else {
  // Let's do substring search
  console.log("Exact match failed, trying index-based replace...");
  const startIdx = content.indexOf('if (isUser) {');
  const endIdx = content.indexOf('msgEl.setAttribute("style", "align-self: flex-start; max-width: 85%; margin-bottom: 2px; text-align: left;");', startIdx + 20);
  const endBlockIdx = content.indexOf('}', endIdx + 200);
  if (startIdx !== -1 && endBlockIdx !== -1) {
    // Find the end of the block
    content = content.substring(0, startIdx) + newSnippet + content.substring(endBlockIdx + 1);
    fs.writeFileSync(filePath, content, 'utf8');
    console.log("Substring replaced successfully!");
  } else {
    console.error("Target snippet not found in file!");
    process.exit(1);
  }
}
