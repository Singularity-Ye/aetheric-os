import fs from 'fs';
import path from 'path';

const filePath = path.resolve('src/aetheric/AethericShellView.ts');
let content = fs.readFileSync(filePath, 'utf8');

const replacement = `  private async renderContextAgent(parent: HTMLElement, node: KnowledgeNodeViewModel): Promise<void> {
    const card = parent.createDiv({ cls: "aos-context-card" });
    card.setAttribute("style", "padding: 12px; display: flex; flex-direction: column; gap: 12px;");
    
    // 1. Last Agent Run History (If any)
    const historySection = card.createDiv({ cls: "aos-agent-history-section" });
    const histTitle = historySection.createDiv({ text: "📋 节点执行历史" });
    histTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 6px; color: var(--aos-ink-muted);");
    if (node.lastAgent) {
      this.contextField(historySection, "Agent", node.lastAgent.agent);
      this.contextField(historySection, "动作", node.lastAgent.action);
    } else {
      historySection.createDiv({ cls: "aos-empty-state", text: "该节点尚无历史 Agent 动作记录。" });
    }

    // 2. Interactive Workspace Tools/Capabilities MVP
    const ws = this.getWorkspace();
    if (ws && ws.capabilities.length > 0) {
      const capSection = card.createDiv({ cls: "aos-agent-caps-mvp" });
      capSection.setAttribute("style", "border-top: 1px solid var(--aos-border); padding-top: 10px;");
      const capTitle = capSection.createDiv({ text: "🛠️ 节点专属工作域工具" });
      capTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 8px; color: var(--aos-gold);");
      for (const cap of ws.capabilities) {
        const btn = capSection.createEl("button", {
          cls: "aos-topbar-button",
          text: "运行: " + cap.name
        });
        btn.setAttribute("style", "width: 100%; margin-bottom: 6px; text-align: left; height: auto; padding: 6px 10px; font-size: 9px; display: block;");
        btn.addEventListener("click", () => {
          new Notice("正在调度 Agent 运行【" + cap.name + "】对当前节点【" + node.title + "】进行深度加工...");
          void this.appendAgentChatMessage("System", "调度运行能力: " + cap.name + " (" + cap.id + ") 对当前节点 《" + node.title + "》");
        });
      }
    }

    // 3. Interactive Agent Chat Sidebar/Bridge
    const chatSection = card.createDiv({ cls: "aos-agent-chat-mvp" });
    chatSection.setAttribute("style", "border-top: 1px solid var(--aos-border); padding-top: 10px;");
    const chatTitle = chatSection.createDiv({ text: "💬 协同 Agent 浮窗对讲机" });
    chatTitle.setAttribute("style", "font-size: 11px; font-weight: bold; margin-bottom: 8px; color: var(--aos-gold);");
    
    const chatLog = chatSection.createDiv();
    chatLog.setAttribute("style", "max-height: 240px; overflow-y: auto; background: rgba(0,0,0,0.03); border: 1px solid var(--aos-border); border-radius: 4px; padding: 8px; font-size: 10px; margin-bottom: 6px; text-align: left; display: flex; flex-direction: column; gap: 8px;");

    const chatFilePath = ".agents/chat/dialog.md";
    let chatContent = "";
    try {
      const adapter = this.app.vault.adapter;
      const exists = await adapter.exists(chatFilePath);
      if (!exists) {
        await adapter.mkdir(".agents/chat").catch(() => {});
        chatContent = "**System** (" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "): 🤖 [天工台]: 你好！协作 Agent 对讲机已启动。本对话与本地 \`.agents/chat/dialog.md\` 实时绑定。我在下一次唤醒时将读取此处的历史上下文。";
        await adapter.write(chatFilePath, chatContent);
      } else {
        chatContent = await adapter.read(chatFilePath);
      }
    } catch (e) {
      console.warn("Failed to load chat dialog file", e);
      chatContent = "**System** (error): 无法加载对话文件: " + (e instanceof Error ? e.message : String(e));
    }

    const paragraphs = chatContent.split("\\n\\n").filter(Boolean);
    for (const para of paragraphs) {
      const match = para.match(/^\\*\\*([^*]+)\\*\\* \\(([^)]+)\\): ([\\s\\S]*)/);
      if (match) {
        const sender = match[1];
        const time = match[2];
        const text = match[3];
        const msgEl = chatLog.createDiv();
        const isUser = sender.trim().toLowerCase() === "user";
        const isSystem = sender.trim().toLowerCase() === "system";
        
        if (isUser) {
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
        }
      } else {
        const msgEl = chatLog.createDiv({ text: para });
        msgEl.setAttribute("style", "color: var(--aos-ink-muted); font-style: italic; font-size: 9px;");
      }
    }
    
    setTimeout(() => {
      chatLog.scrollTop = chatLog.scrollHeight;
    }, 50);

    const inputRow = chatSection.createDiv();
    inputRow.setAttribute("style", "display: flex; gap: 6px;");
    const chatInput = inputRow.createEl("input", { placeholder: "向 Agent 提问..." });
    chatInput.setAttribute("style", "flex: 1; font-size: 10px; height: 26px; padding: 0 8px; border-radius: 6px; border: 1px solid var(--aos-border); background: var(--aos-surface); color: var(--aos-ink);");
    const sendBtn = inputRow.createEl("button", { cls: "aos-chat-send-btn", text: "发送" });
    sendBtn.setAttribute("style", "font-size: 10px; height: 26px; padding: 0 10px; font-weight: bold; border-radius: 6px; border: 1px solid var(--aos-border); background: var(--aos-surface); cursor: pointer;");
    
    const handleSend = async () => {
      const question = chatInput.value.trim();
      if (!question) return;
      chatInput.value = "";
      await this.appendAgentChatMessage("User", question);
    };

    sendBtn.addEventListener("click", handleSend);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") handleSend();
    });
  }

  private async appendAgentChatMessage(sender: string, message: string): Promise<void> {
    const chatFilePath = ".agents/chat/dialog.md";
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const formatted = "\\n\\n**" + sender + "** (" + time + "): " + message;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(chatFilePath)) {
        await adapter.append(chatFilePath, formatted);
      } else {
        await adapter.write(chatFilePath, formatted);
      }
    } catch (e) {
      new Notice("写入对话失败: " + e);
    }
  }`;

const startIdx = content.indexOf("private renderContextAgent(");
const endIdx = content.indexOf("private async renderContextPreview(");

if (startIdx !== -1 && endIdx !== -1) {
  content = content.substring(0, startIdx) + replacement + "\n\n" + content.substring(endIdx);
  fs.writeFileSync(filePath, content, 'utf8');
  console.log("Chat bridge successfully applied!");
} else {
  console.error("Bounds not found!");
  process.exit(1);
}
