/**
 * HermesClient: Dedicated client for local Hermes Agent Gateway (127.0.0.1:8642).
 * Enables native Obsidian-to-Hermes agent workflows, session management, and chat execution.
 */

export interface HermesSession {
  id: string;
  source?: string;
  model?: string;
  title: string;
  started_at?: number;
  ended_at?: number;
  last_active?: number;
  message_count?: number;
  tool_call_count?: number;
  input_tokens?: number;
  output_tokens?: number;
  preview?: string;
}

export interface HermesToolCall {
  id?: string;
  type?: string;
  function?: {
    name: string;
    arguments: string;
  };
}

export interface HermesMessage {
  id?: number | string;
  session_id?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  reasoning?: string | null;
  reasoning_content?: string | null;
  tool_calls?: HermesToolCall[] | null;
  tool_name?: string | null;
  timestamp?: number;
  finish_reason?: string | null;
}

export interface HermesChatResponse {
  object?: string;
  session_id: string;
  message: {
    role: "assistant";
    content: string;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export class HermesClient {
  private baseUrl = "http://127.0.0.1:8642";
  private apiKey: string = "";

  constructor(apiKeyOverride?: string, baseUrlOverride?: string) {
    if (baseUrlOverride) this.baseUrl = baseUrlOverride;
    if (apiKeyOverride) {
      this.apiKey = apiKeyOverride;
    } else {
      this.apiKey = this.discoverLocalApiKey();
    }
  }

  /**
   * Safely discovers local Hermes API key from %LOCALAPPDATA%/hermes/.env
   */
  private discoverLocalApiKey(): string {
    try {
      if (typeof window !== "undefined" && (window as any).require) {
        const fs = (window as any).require("fs");
        const path = (window as any).require("path");
        const process = (window as any).require("process");
        const localAppData =
          process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local");
        const envPath = path.join(localAppData, "hermes", ".env");
        if (fs.existsSync(envPath)) {
          const content = fs.readFileSync(envPath, "utf-8");
          const match = content.match(/API_SERVER_KEY=(.+)/);
          if (match && match[1]) {
            return match[1].trim();
          }
        }
      }
    } catch (e) {
      console.warn("[HermesClient] Failed to read local .env key:", e);
    }
    return "aos_local_5bd4c1e720f849b7a6e03fcb932d8a61";
  }

  getApiKey(): string {
    return this.apiKey;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Check whether the local Hermes Gateway is reachable and online.
   */
  async checkHealth(): Promise<{ online: boolean; sessionCount: number; model?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!res.ok) return { online: false, sessionCount: 0 };
      const data = await res.json();
      const sessions = Array.isArray(data.data) ? data.data : [];
      const model = sessions[0]?.model || "gpt-5.6-luna";
      return { online: true, sessionCount: sessions.length, model };
    } catch {
      return { online: false, sessionCount: 0 };
    }
  }

  /**
   * List all Hermes sessions sorted by last active / started time.
   */
  async listSessions(limit = 60): Promise<HermesSession[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions?limit=${limit}`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return Array.isArray(data.data) ? data.data : [];
    } catch (err) {
      console.error("[HermesClient] listSessions failed:", err);
      return [];
    }
  }

  /**
   * Create a new Hermes session with an optional custom title.
   */
  async createSession(title?: string): Promise<HermesSession | null> {
    try {
      const sessionId = `aos_hermes_work_${Date.now()}`;
      const sessionTitle = title || `天工工造 · ${new Date().toLocaleDateString("zh-CN")}`;
      const res = await fetch(`${this.baseUrl}/api/sessions`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ id: sessionId, title: sessionTitle }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data.session as HermesSession) || { id: sessionId, title: sessionTitle };
    } catch (err) {
      console.error("[HermesClient] createSession failed:", err);
      return null;
    }
  }

  /**
   * Retrieve all messages and tool invocations for a given session.
   */
  async getSessionMessages(sessionId: string): Promise<HermesMessage[]> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
        method: "GET",
        headers: this.getHeaders(),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.data) ? data.data : [];
    } catch (err) {
      console.error(`[HermesClient] getSessionMessages(${sessionId}) failed:`, err);
      return [];
    }
  }

  /**
   * Delete a session by its ID.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
        method: "DELETE",
        headers: this.getHeaders(),
      });
      return res.ok;
    } catch (err) {
      console.error(`[HermesClient] deleteSession(${sessionId}) failed:`, err);
      return false;
    }
  }

  /**
   * Send a chat prompt to Hermes and await the agent's full turn (including tool execution).
   */
  async sendMessage(sessionId: string, message: string): Promise<HermesChatResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/chat`, {
        method: "POST",
        headers: this.getHeaders(),
        body: JSON.stringify({ message }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      const data = await res.json();
      return data as HermesChatResponse;
    } catch (err) {
      console.error(`[HermesClient] sendMessage failed:`, err);
      return null;
    }
  }
}
